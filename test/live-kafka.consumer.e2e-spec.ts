import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Kafka, type Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEventPayload, type EventTopic } from '@ecom/contracts';
import { closePool, getPool } from './../src/db/pool.js';
import { StockReservationsRepository } from './../src/stock/stock-reservations.repository.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

const RUN_LIVE = process.env.RUN_KAFKA_E2E === '1';

// The e2e config switches the consumer off for every file, and this one needs it
// on, so the flag has to be set *before* `AppModule` is imported: the Joi
// validation and `ConfigModule.forRoot()` capture the environment while that
// module is evaluated. Hence the dynamic import inside `beforeAll`.
if (RUN_LIVE) {
  process.env.KAFKA_CONSUMER_ENABLED = 'true';
}

const RUN_ID = randomUUID().slice(0, 8);
const ORDER_TOPIC = 'order.created';
const IMPORT_TOPIC = 'product.imported';
/** Exactly the group the strategy joins, with no `-server` suffix. */
const GROUP_ID = 'catalog-svc';
const GROUP_ID_NO_POSTFIX = 'catalog-svc-server';
/** Time for the group to join and settle on its start offset. */
const GROUP_SETTLE_MS = 3000;

function brokers(): string[] {
  return (process.env.KAFKA_BROKERS ?? 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

/**
 * The live proof for `cat-008`: a record published to the real broker is
 * consumed by the Nest Kafka transport under group `catalog-svc`, and both
 * routes on that one consumer do their work — `order.created` still commits a
 * hold (the behaviour `cat-007` shipped, now carried by the shared transport),
 * and `product.imported` applies an import.
 *
 * Skipped unless `RUN_KAFKA_E2E=1`, so the default `pnpm test:e2e` needs no
 * broker. `order-created.e2e-spec.ts` and `product-imported.e2e-spec.ts` cover
 * the same handlers without one; what only this suite can show is that the
 * transport subscribes to both topics as `catalog-svc` and commits its offsets.
 */
describe.runIf(RUN_LIVE)('catalog consumer over a real broker (live)', () => {
  let app: INestApplication;
  let producer: Producer;
  let reservations: StockReservationsRepository;
  let admin: ReturnType<Kafka['admin']>;

  const orderEventId = randomUUID();
  const importEventId = randomUUID();
  const reservationId = randomUUID();
  const orderId = randomUUID();
  let heldProductId: string;
  let importedProductId: string;
  let importedId: string;

  beforeAll(async () => {
    await assertBrokerReady([ORDER_TOPIC, IMPORT_TOPIC]);

    const { AppModule } = await import('../src/app.module.js');
    const { startEventConsumer } = await import(
      '../src/events/consumer-runtime.js'
    );

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    reservations = app.get(StockReservationsRepository);

    // Joins group `catalog-svc` on the Nest transport. Awaited here — unlike
    // `main.ts`, which must not block HTTP on a broker — because every
    // assertion below depends on the consumer being connected.
    const started = await startEventConsumer(app, app.get(ConfigService));
    expect(started).toBe(true);

    const kafka = new Kafka({
      clientId: `catalog-svc-live-${RUN_ID}`,
      brokers: brokers(),
      connectionTimeout: 5000,
    });
    producer = kafka.producer();
    await producer.connect();
    admin = kafka.admin();
    await admin.connect();
  }, 120_000);

  afterAll(async () => {
    if (producer) {
      await producer.disconnect();
    }
    if (admin) {
      await admin.disconnect();
    }

    await cleanup();

    if (app) {
      await app.close();
    }
    await closePool();
  }, 120_000);

  it('commits the hold of a consumed order.created record', async () => {
    heldProductId = randomUUID();
    await insertProduct(heldProductId, `LIVE-ORD-${RUN_ID}`, 8);

    // The hold decrements stock at reserve time, exactly as a checkout does.
    await reservations.reserve(
      reservationId,
      [{ productId: heldProductId, quantity: 3 }],
      900,
    );

    await delay(GROUP_SETTLE_MS);
    await publish(ORDER_TOPIC, orderEventId, {
      orderId,
      orderNumber: `ORD-2026-${RUN_ID}`,
      userId: randomUUID(),
      grandTotal: 42,
      itemsCount: 1,
      reservationId,
      createdAt: new Date().toISOString(),
    });

    const claimed = await waitForRow(
      `SELECT event_id, topic FROM catalog.processed_events WHERE event_id = $1`,
      orderEventId,
      'the consumer never claimed the order.created event',
    );
    expect(claimed.topic).toBe(ORDER_TOPIC);

    const hold = await waitForRow(
      `SELECT status, order_id FROM catalog.stock_reservations WHERE id = $1`,
      reservationId,
      'the consumer never committed the hold',
    );
    expect(hold).toMatchObject({ status: 'committed', order_id: orderId });
  }, 120_000);

  it('applies a consumed product.imported record, variants included', async () => {
    importedProductId = randomUUID();
    importedId = `LIVE-IMP-${RUN_ID}`;

    await delay(GROUP_SETTLE_MS);
    await publish(IMPORT_TOPIC, importEventId, {
      productId: importedProductId,
      sku: importedId,
      name: 'Live Imported Widget',
      slug: `live-imported-${RUN_ID}`,
      price: 19.99,
      stock: 6,
      status: 'active',
      updatedAt: new Date().toISOString(),
      // The 1.9.0 field, on the wire: a consumer pinned below 1.9.0 would
      // dead-letter this record because the payload schema is `.strict()`.
      variants: [{ sku: `${importedId}-RED`, price: '21.50', stock: 2 }],
    });

    const claimed = await waitForRow(
      `SELECT event_id, topic FROM catalog.processed_events WHERE event_id = $1`,
      importEventId,
      'the consumer never claimed the product.imported event',
    );
    expect(claimed.topic).toBe(IMPORT_TOPIC);

    const product = await waitForRow(
      `SELECT sku, source, stock FROM catalog.products WHERE id = $1`,
      importedProductId,
      'the consumer never applied the import',
    );
    expect(product).toMatchObject({ sku: importedId, source: 'import', stock: 6 });

    const { rows: variants } = await getPool().query<{ sku: string; stock: number }>(
      `SELECT sku, stock FROM catalog.product_variants WHERE product_id = $1`,
      [importedProductId],
    );
    expect(variants).toEqual([{ sku: `${importedId}-RED`, stock: 2 }]);

    // D2: the import writes no outbox row, so search learns about it from this
    // topic rather than from a re-emitted product.updated.
    const { rows: outbox } = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.outbox WHERE aggregate_id = $1`,
      [importedProductId],
    );
    expect(outbox[0]!.count).toBe(0);
  }, 120_000);

  it('runs one consumer in group catalog-svc, with no -server suffix', async () => {
    const { groups } = await admin.describeGroups([GROUP_ID, GROUP_ID_NO_POSTFIX]);
    const byId = new Map(groups.map((group) => [group.groupId, group]));

    expect(byId.get(GROUP_ID)?.state).toBe('Stable');
    // `postfixId: ''`: the Nest strategy's default would have created a second
    // group with its own offsets, which is the whole reason for that setting.
    expect(byId.get(GROUP_ID_NO_POSTFIX)?.state).toBe('Dead');

    const offsets = await admin.fetchOffsets({ groupId: GROUP_ID });
    const committed = (topic: string): number[] =>
      (offsets.find((entry) => entry.topic === topic)?.partitions ?? [])
        .map((partition) => Number(partition.offset))
        .filter((offset) => Number.isFinite(offset) && offset > 0);

    // Both routes committed through the one consumer.
    expect(committed(ORDER_TOPIC).length).toBeGreaterThan(0);
    expect(committed(IMPORT_TOPIC).length).toBeGreaterThan(0);
  }, 60_000);

  async function insertProduct(
    id: string,
    sku: string,
    stock: number,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO catalog.products (id, sku, name, slug, price, stock, status)
       VALUES ($1, $2, 'Live Order Consumer Item', $3, 42.00, $4, 'active')`,
      [id, sku, sku.toLowerCase(), stock],
    );
  }

  async function publish(
    topic: EventTopic,
    eventId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Built through the contract so this suite cannot drift from the producer.
    const parsed = parseEventPayload(topic, payload);

    await producer.send({
      topic,
      acks: -1,
      messages: [
        {
          key: eventId,
          value: JSON.stringify({
            id: eventId,
            type: topic,
            producer: topic === ORDER_TOPIC ? 'order-svc' : 'import-svc',
            timestamp: new Date().toISOString(),
            payload: parsed,
          }),
          headers: { 'x-event-id': eventId, 'x-event-type': topic },
        },
      ],
    });
  }

  async function waitForRow(
    sql: string,
    value: string,
    failure: string,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      const { rows } = await getPool().query(sql, [value]);
      if (rows.length > 0) {
        return rows[0] as Record<string, unknown>;
      }
      await delay(500);
    }

    throw new Error(failure);
  }

  async function cleanup(): Promise<void> {
    const pool = getPool();

    await pool.query(
      `DELETE FROM catalog.processed_events WHERE event_id = ANY($1::varchar[])`,
      [[orderEventId, importEventId]],
    );
    await pool.query(
      `DELETE FROM catalog.stock_movements WHERE product_id = ANY($1::uuid[])`,
      [[heldProductId, importedProductId].filter(Boolean)],
    );
    await pool.query(
      `DELETE FROM catalog.stock_reservations WHERE id = $1`,
      [reservationId],
    );
    await pool.query(
      `DELETE FROM catalog.products WHERE id = ANY($1::uuid[])`,
      [[heldProductId, importedProductId].filter(Boolean)],
    );
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fail with an actionable message rather than a kafkajs timeout. */
async function assertBrokerReady(topics: string[]): Promise<void> {
  const admin = new Kafka({
    clientId: `catalog-svc-live-admin-${RUN_ID}`,
    brokers: brokers(),
    connectionTimeout: 5000,
  }).admin();
  const endpoint = brokers().join(', ');

  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `ecom-kafka is not reachable at ${endpoint} (${
        (error as Error).message
      }). Start it with \`docker compose up -d ecom-kafka\`.`,
    );
  }

  try {
    const available = await admin.listTopics();
    const missing = topics.filter((topic) => !available.includes(topic));
    if (missing.length > 0) {
      throw new Error(
        `topic(s) ${missing.join(', ')} missing at ${endpoint}. Provision ` +
          'them with `ecom-infra/scripts/provision-topics.mjs`.',
      );
    }
  } finally {
    await admin.disconnect();
  }
}

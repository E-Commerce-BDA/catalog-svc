import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { closePool, getPool } from './../src/db/pool.js';
import { ConsumerMetrics } from './../src/events/consumer-metrics.js';
import { OrderCreatedHandler } from './../src/events/order-created/order-created.handler.js';
import { ReservationClosedError } from './../src/stock/stock-reservations.errors.js';
import { StockReservationsRepository } from './../src/stock/stock-reservations.repository.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

/**
 * The consumer's database half, exercised without a broker: the handler is the
 * only thing between a Kafka record and the transaction, so calling it directly
 * proves the reservation, the claim and the movement rules.
 */
describe('order.created consumer (e2e)', () => {
  let app: INestApplication<App>;
  let handler: OrderCreatedHandler;
  let reservations: StockReservationsRepository;
  let metrics: ConsumerMetrics;
  const createdProductIds: string[] = [];
  const createdReservationIds: string[] = [];
  const usedEventIds: string[] = [];
  const serviceKey =
    process.env.INTERNAL_SERVICE_KEY ||
    'dev-internal-service-key-change-in-prod';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', { exclude: ['health', 'health/ready'] });
    await app.init();

    handler = app.get(OrderCreatedHandler);
    reservations = app.get(StockReservationsRepository);
    metrics = app.get(ConsumerMetrics);
  });

  afterAll(async () => {
    if (createdProductIds.length > 0) {
      await getPool().query(
        `DELETE FROM catalog.stock_movements WHERE product_id = ANY($1::uuid[])`,
        [createdProductIds],
      );
      await getPool().query(
        `DELETE FROM catalog.stock_reservations WHERE id = ANY($1::uuid[])`,
        [createdReservationIds],
      );
      await getPool().query(
        `DELETE FROM catalog.products WHERE id = ANY($1::uuid[])`,
        [createdProductIds],
      );
    }
    if (usedEventIds.length > 0) {
      await getPool().query(
        `DELETE FROM catalog.processed_events WHERE event_id = ANY($1::varchar[])`,
        [usedEventIds],
      );
    }
    metrics.reset();
    await app.close();
    await closePool();
  });

  async function createProduct(stock: number): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO catalog.products (sku, name, slug, price, stock, status)
       VALUES ($1, 'Order Created Consumer Item', $2, 42.00, $3, 'active')
       RETURNING id`,
      [`SKU-ORC-${suffix}`, `orc-${suffix}`, stock],
    );
    createdProductIds.push(rows[0].id);
    return rows[0].id;
  }

  async function hold(productId: string, quantity: number): Promise<string> {
    const reservationId = randomUUID();
    createdReservationIds.push(reservationId);
    await reservations.reserve(reservationId, [{ productId, quantity }], 900);
    return reservationId;
  }

  function orderCreatedEvent(reservationId: string, orderId: string): unknown {
    const eventId = randomUUID();
    usedEventIds.push(eventId);
    return {
      id: eventId,
      type: 'order.created',
      producer: 'order-svc',
      timestamp: new Date().toISOString(),
      payload: {
        orderId,
        orderNumber: `ORD-${eventId.slice(0, 8)}`,
        userId: randomUUID(),
        grandTotal: 84,
        itemsCount: 1,
        reservationId,
        createdAt: new Date().toISOString(),
      },
    };
  }

  const stockOf = async (productId: string): Promise<number> => {
    const { rows } = await getPool().query<{ stock: number }>(
      `SELECT stock FROM catalog.products WHERE id = $1`,
      [productId],
    );
    return rows[0].stock;
  };

  const movementCount = async (reservationId: string): Promise<number> => {
    const { rows } = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.stock_movements
        WHERE reservation_id = $1`,
      [reservationId],
    );
    return rows[0].count;
  };

  it('commits the hold, stores the order id and moves no stock', async () => {
    const productId = await createProduct(8);
    const reservationId = await hold(productId, 3);
    const orderId = randomUUID();
    const event = orderCreatedEvent(reservationId, orderId);

    expect(await stockOf(productId)).toBe(5);
    const movementsBefore = await movementCount(reservationId);

    const outcome = await handler.handle(event);

    expect(outcome).toMatchObject({
      kind: 'committed',
      reservationId,
      orderId,
      outcome: 'committed',
    });

    const { rows } = await getPool().query<{ status: string; order_id: string }>(
      `SELECT status, order_id FROM catalog.stock_reservations WHERE id = $1`,
      [reservationId],
    );
    expect(rows[0].status).toBe('committed');
    expect(rows[0].order_id).toBe(orderId);

    // Stock was decremented when the hold was taken; committing must not do it
    // again, and must not write a second movement.
    expect(await stockOf(productId)).toBe(5);
    expect(await movementCount(reservationId)).toBe(movementsBefore);
  });

  it('treats a redelivered event id as a duplicate', async () => {
    const productId = await createProduct(4);
    const reservationId = await hold(productId, 1);
    const event = orderCreatedEvent(reservationId, randomUUID());

    await expect(handler.handle(event)).resolves.toMatchObject({
      kind: 'committed',
    });
    await expect(handler.handle(event)).resolves.toMatchObject({
      kind: 'duplicate',
    });

    const { rows } = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.processed_events
        WHERE event_id = $1`,
      [(event as { id: string }).id],
    );
    expect(rows[0].count).toBe(1);
    expect(await movementCount(reservationId)).toBe(1);
  });

  it('reports a new event for an already committed hold as a no-op', async () => {
    const productId = await createProduct(4);
    const reservationId = await hold(productId, 2);
    const orderId = randomUUID();

    await handler.handle(orderCreatedEvent(reservationId, orderId));

    const replay = await handler.handle(
      orderCreatedEvent(reservationId, orderId),
    );

    expect(replay).toMatchObject({
      kind: 'committed',
      outcome: 'already-committed',
      orderId,
    });
    expect(await stockOf(productId)).toBe(2);
  });

  it('refuses a released hold and leaves the event unclaimed', async () => {
    const productId = await createProduct(3);
    const reservationId = await hold(productId, 1);
    await reservations.release(reservationId);
    const event = orderCreatedEvent(reservationId, randomUUID());

    await expect(handler.handle(event)).rejects.toBeInstanceOf(
      ReservationClosedError,
    );

    // The claim and the commit share one transaction, so a terminal outcome
    // must not record the event as processed: the DLQ is the only record.
    const { rows } = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.processed_events
        WHERE event_id = $1`,
      [(event as { id: string }).id],
    );
    expect(rows[0].count).toBe(0);
    // The release already restored the unit.
    expect(await stockOf(productId)).toBe(3);
  });

  it('rejects a hold that belongs to a different order', async () => {
    const productId = await createProduct(2);
    const reservationId = await hold(productId, 1);
    await handler.handle(orderCreatedEvent(reservationId, randomUUID()));

    await expect(
      handler.handle(orderCreatedEvent(reservationId, randomUUID())),
    ).rejects.toMatchObject({ response: { code: 'RESERVATION_MISMATCH' } });
  });

  it('retries a reservation that does not exist', async () => {
    await expect(
      handler.handle(orderCreatedEvent(randomUUID(), randomUUID())),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('ignores an order that never held stock', async () => {
    await expect(
      handler.handle(orderCreatedEvent('', randomUUID())),
    ).resolves.toEqual({ kind: 'ignored', reason: 'no-reservation' });
  });

  it('exposes the consumer counters behind the service key', async () => {
    const unauthorized = await request(app.getHttpServer()).get(
      '/api/v1/catalog/internal/consumer-stats',
    );
    expect(unauthorized.status).toBe(401);

    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/internal/consumer-stats')
      .set('x-service-key', serviceKey)
      .expect(200);

    expect(res.body).toEqual({
      committed: 0,
      duplicate: 0,
      ignored: 0,
      invalid: 0,
      dlq: 0,
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

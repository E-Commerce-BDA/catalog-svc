import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { eventEnvelopeSchema, parseEventEnvelope } from '@ecom/contracts';
import { OutboxRelay, RecordingPublisher } from '@ecom/messaging';
import { OUTBOX_PUBLISHER, OUTBOX_RELAY } from '@ecom/messaging/nest';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { AppModule } from './../src/app.module.js';
import { closePool, getPool } from './../src/db/pool.js';
import { withTransaction } from './../src/db/tx.js';
import { CatalogOutbox } from './../src/outbox/catalog-outbox.js';
import { ProductsRepository } from './../src/products/products.repository.js';
import { catalogOutboxRows, deleteCatalogOutbox } from './outbox.helpers.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

const RUN_ID = randomUUID().slice(0, 8);

describe('Catalog outbox (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let moduleRelay: OutboxRelay;
  let publisher: RecordingPublisher;
  let adminToken: string;

  const productIds: string[] = [];
  const categoryIds: string[] = [];
  const badgeIds: string[] = [];
  /** Every aggregate this suite writes events for; teardown scopes to these. */
  const aggregateIds: string[] = [];

  function trackProduct(id: string): string {
    productIds.push(id);
    aggregateIds.push(id);
    return id;
  }

  function trackCategory(id: string): string {
    categoryIds.push(id);
    aggregateIds.push(id);
    return id;
  }

  function trackBadge(id: string): string {
    badgeIds.push(id);
    return id;
  }

  /** Admin write against the prefixed API; every mutation needs bearer auth. */
  function post(path: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
  }

  function patch(path: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/v1${path}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
  }

  function del(path: string) {
    return request(app.getHttpServer())
      .delete(`/api/v1${path}`)
      .set('Authorization', `Bearer ${adminToken}`);
  }

  function put(path: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .put(`/api/v1${path}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
  }

  async function createProduct(label: string): Promise<{
    id: string;
    updatedAt: string;
  }> {
    const created = await post('/catalog/products', {
      sku: `outbox-${RUN_ID}-${label}`,
      name: `Outbox ${label}`,
      slug: `outbox-${label}-${RUN_ID}`,
      price: 19.99,
      stock: 5,
      status: 'active',
    }).expect(201);

    const product = created.body.product as { id: string; updatedAt: string };
    trackProduct(product.id);
    return product;
  }

  /**
   * Drain the real module relay until this aggregate's rows are published.
   *
   * The queue is shared with the other e2e suites (which never start a relay),
   * so one drain may spend its whole batch on their older rows. The wait
   * therefore counts *this* aggregate only, and each cycle retries.
   */
  async function drainUntilPublished(
    aggregateId: string,
    expected: number,
  ): Promise<void> {
    let last = '';

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const rows = await catalogOutboxRows(pool, [aggregateId]);
      if (rows.filter((row) => row.status === 'published').length >= expected) {
        return;
      }

      const result = await moduleRelay.drainOnce();
      last = JSON.stringify(result);
    }

    throw new Error(
      `relay did not publish ${expected} row(s) for ${aggregateId}; last drain ${last}`,
    );
  }

  beforeAll(async () => {
    publisher = new RecordingPublisher();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OUTBOX_PUBLISHER)
      .useValue(publisher)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', {
      exclude: ['health', 'health/ready'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );
    await app.init();

    const jwtService = app.get(JwtService);
    const configService = app.get(ConfigService);
    const secret = configService.getOrThrow<string>('JWT_SECRET');

    adminToken = await jwtService.signAsync(
      {
        sub: '0190a8b0-0000-7000-8000-000000000001',
        email: 'admin@example.com',
        roles: ['admin'],
      },
      {
        secret,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
        expiresIn: '1h',
      },
    );

    pool = getPool();
    moduleRelay = app.get<OutboxRelay>(OUTBOX_RELAY);
  });

  afterAll(async () => {
    if (pool) {
      await deleteCatalogOutbox(pool, aggregateIds);

      if (productIds.length > 0) {
        // Children (variants, images, options, discounts, badges) cascade.
        await pool.query(`DELETE FROM catalog.products WHERE id = ANY($1::uuid[])`, [
          productIds,
        ]);
      }
      if (badgeIds.length > 0) {
        await pool.query(`DELETE FROM catalog.badges WHERE id = ANY($1::uuid[])`, [
          badgeIds,
        ]);
      }
      if (categoryIds.length > 0) {
        await pool.query(
          `DELETE FROM catalog.categories WHERE id = ANY($1::uuid[])`,
          [categoryIds],
        );
      }
    }

    if (app) {
      await app.close();
    }
    await closePool();
  });

  beforeEach(() => {
    publisher.reset();
  });

  it('writes exactly one valid product.updated row when a product is created', async () => {
    const product = await createProduct('create');

    const rows = await catalogOutboxRows(pool, [product.id]);
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row).toMatchObject({
      aggregate_type: 'product',
      aggregate_id: product.id,
      event_type: 'product.updated',
      status: 'pending',
      attempts: 0,
      last_error: null,
      locked_until: null,
      published_at: null,
    });

    expect(eventEnvelopeSchema.safeParse(row!.envelope).success).toBe(true);
    expect(row!.envelope).toMatchObject({
      id: row!.event_id,
      type: 'product.updated',
      topic: 'product.updated',
      eventType: 'product.updated',
      version: 1,
      producer: 'catalog-svc',
      idempotencyKey: row!.event_id,
    });

    // The row's own timestamp, not the moment the relay happens to run.
    expect(row!.envelope.timestamp).toBe(product.updatedAt);

    const payload = parseEventEnvelope('product.updated', row!.envelope);
    expect(payload).toMatchObject({
      productId: product.id,
      sku: `outbox-${RUN_ID}-create`,
      name: 'Outbox create',
      slug: `outbox-create-${RUN_ID}`,
      price: 19.99,
      stock: 5,
      status: 'active',
      updatedAt: product.updatedAt,
    });
  });

  it('emits on variant and discount mutations, not just on the product itself', async () => {
    const product = await createProduct('children');
    expect(await catalogOutboxRows(pool, [product.id])).toHaveLength(1);

    const variantResponse = await post(`/catalog/products/${product.id}/variants`, {
      sku: `outbox-${RUN_ID}-variant`,
      price: 21.5,
      stock: 2,
    }).expect(201);
    const variantId = variantResponse.body.variant.id as string;

    let rows = await catalogOutboxRows(pool, [product.id]);
    expect(rows).toHaveLength(2);
    expect(rows.at(-1)!.event_type).toBe('product.updated');

    await del(`/catalog/variants/${variantId}`).expect(204);
    expect(await catalogOutboxRows(pool, [product.id])).toHaveLength(3);

    const discountResponse = await post(
      `/catalog/products/${product.id}/discounts`,
      {
        discountType: 'percent',
        value: 10,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ).expect(201);
    const discountId = discountResponse.body.discount.id as string;

    expect(await catalogOutboxRows(pool, [product.id])).toHaveLength(4);

    await del(`/catalog/discounts/${discountId}`).expect(204);

    rows = await catalogOutboxRows(pool, [product.id]);
    expect(rows).toHaveLength(5);
    // Every one of them describes the product the storefront renders.
    for (const row of rows) {
      expect(row.aggregate_type).toBe('product');
      expect(row.aggregate_id).toBe(product.id);
      expect(parseEventEnvelope('product.updated', row.envelope).productId).toBe(
        product.id,
      );
    }
  });

  it('emits when badge assignments change the product card', async () => {
    const product = await createProduct('badges');

    const badgeResponse = await post('/catalog/badges', {
      key: `outbox-${RUN_ID}`,
      label: 'Outbox',
      bg: '#101010',
      textColor: '#ffffff',
    }).expect(201);
    const badgeId = trackBadge(badgeResponse.body.badge.id as string);

    await put(`/catalog/products/${product.id}/badges`, {
      badges: [{ badgeId }],
    }).expect(200);

    const rows = await catalogOutboxRows(pool, [product.id]);
    expect(rows).toHaveLength(2);
    expect(rows.at(-1)!.event_type).toBe('product.updated');
  });

  it('writes category.updated for create, update and delete', async () => {
    const created = await post('/catalog/categories', {
      name: `Outbox Category ${RUN_ID}`,
      isActive: true,
    }).expect(201);
    const categoryId = trackCategory(created.body.category.id as string);

    await patch(`/catalog/categories/${categoryId}`, {
      name: `Outbox Category Renamed ${RUN_ID}`,
    }).expect(200);

    await del(`/catalog/categories/${categoryId}`).expect(204);

    const rows = await catalogOutboxRows(pool, [categoryId]);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.aggregate_type).toBe('category');
      expect(row.event_type).toBe('category.updated');
      expect(eventEnvelopeSchema.safeParse(row.envelope).success).toBe(true);
      expect(parseEventEnvelope('category.updated', row.envelope).categoryId).toBe(
        categoryId,
      );
    }

    expect(parseEventEnvelope('category.updated', rows[0]!.envelope)).toMatchObject({
      name: `Outbox Category ${RUN_ID}`,
      isActive: true,
    });
    expect(parseEventEnvelope('category.updated', rows[1]!.envelope)).toMatchObject({
      name: `Outbox Category Renamed ${RUN_ID}`,
      isActive: true,
    });
    // The delete payload is the row that committed: inactive, new timestamp.
    expect(parseEventEnvelope('category.updated', rows[2]!.envelope)).toMatchObject({
      isActive: false,
    });
  });

  it('publishes keyed by aggregate id, in order, and marks the rows published', async () => {
    const product = await createProduct('publish');

    await post(`/catalog/products/${product.id}/variants`, {
      sku: `outbox-${RUN_ID}-publish-variant`,
      price: 20,
      stock: 1,
    }).expect(201);

    const pending = await catalogOutboxRows(pool, [product.id]);
    expect(pending).toHaveLength(2);

    await drainUntilPublished(product.id, 2);

    const rows = await catalogOutboxRows(pool, [product.id]);
    for (const row of rows) {
      expect(row.status).toBe('published');
      expect(row.published_at).toBeInstanceOf(Date);
      expect(row.locked_until).toBeNull();
    }

    const published = publisher.published.filter(
      (entry) => entry.key === product.id,
    );
    expect(published).toHaveLength(2);
    // Sequential publish in claim order is what keeps per-product order honest.
    expect(published[0]!.envelope.id).toBe(rows[0]!.event_id);
    expect(published[1]!.envelope.id).toBe(rows[1]!.event_id);
    expect(published[0]!.topic).toBe('product.updated');
    expect(published[0]!.envelope).toEqual(rows[0]!.envelope);
  });

  it('writes nothing for a rejected mutation', async () => {
    const product = await createProduct('rejected');
    const before = await catalogOutboxRows(pool, [product.id]);

    await patch(`/catalog/products/${randomUUID()}`, { name: 'Nope' }).expect(404);

    expect(await catalogOutboxRows(pool, [product.id])).toHaveLength(before.length);
  });

  it('rolls the row and the event back together when the transaction fails', async () => {
    const repository = app.get(ProductsRepository);
    const outbox = app.get(CatalogOutbox);
    const sku = `outbox-${RUN_ID}-rollback`;

    let leakedId = '';

    await expect(
      withTransaction(async (client) => {
        const created = await repository.create(
          {
            sku,
            name: 'Outbox Rollback',
            slug: `outbox-rollback-${RUN_ID}`,
            price: 12.5,
          },
          client,
        );
        leakedId = created.id;

        await outbox.recordProduct(client, created);

        // Stands in for any failure between the event write and the commit.
        // If the outbox lived outside the transaction, this row would survive.
        throw new Error('forced failure after the outbox write');
      }),
    ).rejects.toThrow('forced failure after the outbox write');

    expect(leakedId).not.toBe('');

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM catalog.products WHERE id = $1`,
      [leakedId],
    );
    expect(rows).toHaveLength(0);
    expect(await catalogOutboxRows(pool, [leakedId])).toHaveLength(0);
  });
});

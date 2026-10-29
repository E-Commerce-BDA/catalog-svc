import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { closePool, getPool } from './../src/db/pool.js';
import { StockReservationsService } from './../src/stock/stock-reservations.service.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

describe('Internal Service-to-Service APIs (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let adminToken: string;
  // e2e files share one database and run sequentially; leaving fixtures active
  // pushes the seeded products off the first page of the public listing.
  const createdProductIds: string[] = [];
  const serviceKey =
    process.env.INTERNAL_SERVICE_KEY ||
    'dev-internal-service-key-change-in-prod';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

    jwtService = app.get(JwtService);
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
  });

  afterAll(async () => {
    if (createdProductIds.length > 0) {
      await getPool().query(
        `UPDATE catalog.products SET status = 'archived' WHERE id = ANY($1::uuid[])`,
        [createdProductIds],
      );
    }
    await app.close();
    await closePool();
  });

  it('should enforce x-service-key authentication on internal routes', async () => {
    // 1. Missing header -> 401
    await request(app.getHttpServer())
      .get('/api/v1/catalog/internal/products')
      .expect(401);

    // 2. Invalid header -> 401
    await request(app.getHttpServer())
      .get('/api/v1/catalog/internal/products')
      .set('x-service-key', 'wrong-key')
      .expect(401);

    // 3. Valid header -> 200
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/internal/products')
      .set('x-service-key', serviceKey)
      .expect(200);

    expect(res.body).toEqual({ data: [] });
  });

  it('should validate stock level and reject missing products', async () => {
    // Non-existent product -> 404
    await request(app.getHttpServer())
      .get(
        '/api/v1/catalog/internal/stock?productId=0190a8b0-0000-7000-8000-000000000999',
      )
      .set('x-service-key', serviceKey)
      .expect(404);

    // Create a product
    const slugSuffix = Math.random().toString(36).substring(2, 9);
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Stock Check Item',
        slug: `stock-check-${slugSuffix}`,
        sku: `SKU-STK-${slugSuffix}`,
        price: 25.0,
        stock: 8,
        status: 'active',
      })
      .expect(201);

    const productId = createRes.body.product.id;
    createdProductIds.push(productId);

    // Check stock via internal endpoint
    const stockRes = await request(app.getHttpServer())
      .get(`/api/v1/catalog/internal/stock?productId=${productId}`)
      .set('x-service-key', serviceKey)
      .expect(200);

    expect(stockRes.body.productId).toBe(productId);
    expect(stockRes.body.stock).toBe(8);
    expect(stockRes.body.available).toBe(true);
  });

  const reserveUrl = '/api/v1/catalog/internal/stock/reserve';
  const releaseUrl = '/api/v1/catalog/internal/stock/release';
  const commitUrl = '/api/v1/catalog/internal/stock/commit';

  async function createProduct(label: string, stock: number): Promise<string> {
    const suffix = Math.random().toString(36).substring(2, 9);
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: label,
        slug: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${suffix}`,
        sku: `SKU-${suffix}`,
        price: 99.0,
        stock,
        status: 'active',
      })
      .expect(201);
    createdProductIds.push(res.body.product.id);
    return res.body.product.id;
  }

  async function stockOf(productId: string): Promise<number> {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/internal/stock?productId=${productId}`)
      .set('x-service-key', serviceKey)
      .expect(200);
    return res.body.stock;
  }

  // Return the supertest chain (not a promise) so tests can still `.expect()`.
  type ReservationChain = ReturnType<ReturnType<typeof request>['post']>;

  function reserve(
    reservationId: string,
    productId: string,
    quantity: number,
  ): ReservationChain {
    return request(app.getHttpServer())
      .post(reserveUrl)
      .set('x-service-key', serviceKey)
      .send({ reservationId, items: [{ productId, quantity }] });
  }

  it('reserves stock and replays the same reservation without decrementing twice', async () => {
    const productId = await createProduct('Atomic Reservation Item', 10);
    const reservationId = randomUUID();

    const first = await reserve(reservationId, productId, 4).expect(201);
    expect(first.body.reservationId).toBe(reservationId);
    expect(first.body.status).toBe('held');
    expect(first.body.expiresAt).toBeDefined();
    expect(first.body.items[0].remainingStock).toBe(6);
    expect(await stockOf(productId)).toBe(6);

    const replay = await reserve(reservationId, productId, 4).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(await stockOf(productId)).toBe(6);

    const { rows } = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.stock_movements
        WHERE reservation_id = $1 AND reason = 'sale'`,
      [reservationId],
    );
    expect(rows[0].count).toBe(1);
  });

  it('rolls back a reservation that cannot be satisfied', async () => {
    const productId = await createProduct('Insufficient Reservation Item', 6);
    await reserve(randomUUID(), productId, 4).expect(201);

    const conflict = await reserve(randomUUID(), productId, 10).expect(409);
    expect(conflict.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(productId)).toBe(2);
  });

  it('releases the stored items once, even when release is replayed', async () => {
    const productId = await createProduct('Release Replay Item', 10);
    const reservationId = randomUUID();
    await reserve(reservationId, productId, 4).expect(201);

    const released = await request(app.getHttpServer())
      .post(releaseUrl)
      .set('x-service-key', serviceKey)
      .send({ reservationId })
      .expect(201);
    expect(released.body.status).toBe('released');
    expect(released.body.items[0].restoredStock).toBe(10);
    expect(await stockOf(productId)).toBe(10);

    const replay = await request(app.getHttpServer())
      .post(releaseUrl)
      .set('x-service-key', serviceKey)
      .send({ reservationId })
      .expect(201);
    expect(replay.body.items).toEqual([]);
    expect(await stockOf(productId)).toBe(10);
  });

  it('commits a hold without moving stock and refuses to release it afterwards', async () => {
    const productId = await createProduct('Commit Item', 8);
    const reservationId = randomUUID();
    await reserve(reservationId, productId, 3).expect(201);

    const committed = await request(app.getHttpServer())
      .post(commitUrl)
      .set('x-service-key', serviceKey)
      .send({ reservationId })
      .expect(201);
    expect(committed.body.status).toBe('committed');
    expect(await stockOf(productId)).toBe(5);

    const closed = await request(app.getHttpServer())
      .post(releaseUrl)
      .set('x-service-key', serviceKey)
      .send({ reservationId })
      .expect(409);
    expect(closed.body.error.code).toBe('RESERVATION_CLOSED');
  });

  it('expires stale holds and restores their stock', async () => {
    const productId = await createProduct('Expiry Item', 5);
    const reservationId = randomUUID();
    await reserve(reservationId, productId, 2).expect(201);
    expect(await stockOf(productId)).toBe(3);

    await getPool().query(
      `UPDATE catalog.stock_reservations SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [reservationId],
    );

    const expired = await app.get(StockReservationsService).sweepExpired();
    expect(expired.map((entry) => entry.reservationId)).toContain(
      reservationId,
    );
    expect(await stockOf(productId)).toBe(5);

    const view = await request(app.getHttpServer())
      .get(`/api/v1/catalog/internal/stock/reservations/${reservationId}`)
      .set('x-service-key', serviceKey)
      .expect(200);
    expect(view.body.status).toBe('expired');
  });

  it('rejects the legacy qty field that used to break checkout', async () => {
    const productId = await createProduct('Contract Guard Item', 5);

    const res = await request(app.getHttpServer())
      .post(reserveUrl)
      .set('x-service-key', serviceKey)
      .send({ reservationId: randomUUID(), items: [{ productId, qty: 2 }] })
      .expect(400);

    expect(JSON.stringify(res.body)).toContain('quantity');
  });

  it('accepts the exact body order-svc sends', async () => {
    const productId = await createProduct('Contract Accepted Item', 3);

    const res = await request(app.getHttpServer())
      .post(reserveUrl)
      .set('x-service-key', serviceKey)
      .send({
        reservationId: randomUUID(),
        items: [{ productId, variantId: null, quantity: 2 }],
      })
      .expect(201);

    expect(res.body.items[0].quantity).toBe(2);
  });

  it('should hydrate batch product snapshots for cart-svc', async () => {
    const slugSuffix = Math.random().toString(36).substring(2, 9);
    // Create product
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Cart Hydration Tee',
        slug: `cart-tee-${slugSuffix}`,
        sku: `SKU-HYD-${slugSuffix}`,
        price: 30.0,
        stock: 12,
        status: 'active',
      })
      .expect(201);

    const productId = createRes.body.product.id;
    createdProductIds.push(productId);

    // Attach primary image
    await request(app.getHttpServer())
      .post(`/api/v1/catalog/products/${productId}/images`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        url: 'https://cdn.example.com/tee.jpg',
        alt: 'Hydration Tee',
        isPrimary: true,
      })
      .expect(201);

    // Attach 20% discount
    await request(app.getHttpServer())
      .post(`/api/v1/catalog/products/${productId}/discounts`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        discountType: 'percent',
        value: 20,
        startsAt: new Date(Date.now() - 3600000).toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
      })
      .expect(201);

    // Hydrate snapshot for cart-svc
    const hydrateRes = await request(app.getHttpServer())
      .get(`/api/v1/catalog/internal/products?ids=${productId}`)
      .set('x-service-key', serviceKey)
      .expect(200);

    expect(Array.isArray(hydrateRes.body.data)).toBe(true);
    expect(hydrateRes.body.data.length).toBe(1);

    const snapshot = hydrateRes.body.data[0];
    expect(snapshot.productId).toBe(productId);
    expect(snapshot.productName).toBe('Cart Hydration Tee');
    expect(snapshot.unitPrice).toBe(30.0);
    expect(snapshot.effectivePrice).toBe(24.0);
    expect(snapshot.imageUrl).toBe('https://cdn.example.com/tee.jpg');
    expect(snapshot.available).toBe(true);
    expect(snapshot.stock).toBe(12);

    // Invalid UUID rejection
    await request(app.getHttpServer())
      .get('/api/v1/catalog/internal/products?ids=not-a-valid-uuid')
      .set('x-service-key', serviceKey)
      .expect(400);
  });
});

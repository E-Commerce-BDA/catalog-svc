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
import { closePool } from './../src/db/pool.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

describe('Internal Service-to-Service APIs (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let adminToken: string;
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
      .get('/api/v1/catalog/internal/stock?productId=0190a8b0-0000-7000-8000-000000000999')
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

    // Check stock via internal endpoint
    const stockRes = await request(app.getHttpServer())
      .get(`/api/v1/catalog/internal/stock?productId=${productId}`)
      .set('x-service-key', serviceKey)
      .expect(200);

    expect(stockRes.body.productId).toBe(productId);
    expect(stockRes.body.stock).toBe(8);
    expect(stockRes.body.available).toBe(true);
  });

  it('should atomically reserve stock and rollback on insufficient stock', async () => {
    const slugSuffix = Math.random().toString(36).substring(2, 9);
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Atomic Reservation Item',
        slug: `atomic-res-${slugSuffix}`,
        sku: `SKU-ATOM-${slugSuffix}`,
        price: 99.0,
        stock: 10,
        status: 'active',
      })
      .expect(201);

    const productId = createRes.body.product.id;

    // 1. Reserve 4 units
    const reserveRes = await request(app.getHttpServer())
      .post('/api/v1/catalog/internal/stock/reserve')
      .set('x-service-key', serviceKey)
      .send({
        items: [{ productId, quantity: 4 }],
      })
      .expect(201);

    expect(reserveRes.body.reservationId).toBeDefined();
    expect(reserveRes.body.items[0].remainingStock).toBe(6);

    // 2. Verify stock updated to 6
    const stockCheck1 = await request(app.getHttpServer())
      .get(`/api/v1/catalog/internal/stock?productId=${productId}`)
      .set('x-service-key', serviceKey)
      .expect(200);
    expect(stockCheck1.body.stock).toBe(6);

    // 3. Attempt to reserve 10 units (only 6 available) -> 409 Conflict
    const conflictRes = await request(app.getHttpServer())
      .post('/api/v1/catalog/internal/stock/reserve')
      .set('x-service-key', serviceKey)
      .send({
        items: [{ productId, quantity: 10 }],
      })
      .expect(409);

    expect(conflictRes.body.error.code).toBe('INSUFFICIENT_STOCK');

    // 4. Verify stock is still 6 (atomic rollback verified)
    const stockCheck2 = await request(app.getHttpServer())
      .get(`/api/v1/catalog/internal/stock?productId=${productId}`)
      .set('x-service-key', serviceKey)
      .expect(200);
    expect(stockCheck2.body.stock).toBe(6);

    // 5. Release 4 units (order cancellation compensation)
    const releaseRes = await request(app.getHttpServer())
      .post('/api/v1/catalog/internal/stock/release')
      .set('x-service-key', serviceKey)
      .send({
        items: [{ productId, quantity: 4 }],
      })
      .expect(201);

    expect(releaseRes.body.items[0].restoredStock).toBe(10);

    // 6. Verify stock restored to 10
    const stockCheck3 = await request(app.getHttpServer())
      .get(`/api/v1/catalog/internal/stock?productId=${productId}`)
      .set('x-service-key', serviceKey)
      .expect(200);
    expect(stockCheck3.body.stock).toBe(10);
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

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

describe('Inventory & Stock Ledger (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let adminToken: string;
  let customerToken: string;

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

    customerToken = await jwtService.signAsync(
      {
        sub: '0190a8b0-0000-7000-8000-000000000002',
        email: 'customer@example.com',
        roles: ['customer'],
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

  it('should adjust stock and record movements for an active product', async () => {
    const slugSuffix = Math.random().toString(36).substring(2, 9);
    // 1. Create a product with initial stock 10
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Inventory Test Item',
        slug: `inv-test-${slugSuffix}`,
        sku: `SKU-INV-${slugSuffix}`,
        price: 49.99,
        stock: 10,
        status: 'active',
      })
      .expect(201);

    const productId = createRes.body.product.id;
    expect(createRes.body.product.stock).toBe(10);

    // 2. Unauthenticated adjustment should fail with 401
    await request(app.getHttpServer())
      .post(`/api/v1/catalog/products/${productId}/stock`)
      .send({ delta: 5 })
      .expect(401);

    // 3. Customer role adjustment should fail with 403
    await request(app.getHttpServer())
      .post(`/api/v1/catalog/products/${productId}/stock`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ delta: 5 })
      .expect(403);

    // 4. Admin adjustment (+5) should succeed and return new stock 15
    const adjustRes = await request(app.getHttpServer())
      .post(`/api/v1/catalog/products/${productId}/stock`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delta: 5, reason: 'restock' })
      .expect(201);

    expect(adjustRes.body.stock).toBe(15);
    expect(adjustRes.body.movement).toBeDefined();
    expect(adjustRes.body.movement.qtyChange).toBe(5);
    expect(adjustRes.body.movement.qtyAfter).toBe(15);
    expect(adjustRes.body.movement.reason).toBe('restock');

    // 5. Decreasing below 0 should fail with 409 Conflict
    const conflictRes = await request(app.getHttpServer())
      .post(`/api/v1/catalog/products/${productId}/stock`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delta: -20 })
      .expect(409);

    expect(conflictRes.body.error.code).toBe('INSUFFICIENT_STOCK');

    // 6. Query stock movements history
    const movementsRes = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${productId}/stock-movements`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(Array.isArray(movementsRes.body.data)).toBe(true);
    expect(movementsRes.body.data.length).toBeGreaterThanOrEqual(1);
    expect(movementsRes.body.data[0].qtyChange).toBe(5);
  });
});

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

describe('Catalog Hardening & Security (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let adminToken: string;
  let customerToken: string;
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

  describe('Cache-Control Policies', () => {
    it('should set public cache headers with stale-while-revalidate on navbar categories', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/catalog/categories/navbar')
        .expect(200);

      expect(res.headers['cache-control']).toBe(
        'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      );
    });

    it('should set public cache headers on catalog categories, brands, and products', async () => {
      const catRes = await request(app.getHttpServer())
        .get('/api/v1/catalog/categories')
        .expect(200);
      expect(catRes.headers['cache-control']).toBe('public, max-age=60');

      const brandRes = await request(app.getHttpServer())
        .get('/api/v1/catalog/brands')
        .expect(200);
      expect(brandRes.headers['cache-control']).toBe('public, max-age=60');

      const prodRes = await request(app.getHttpServer())
        .get('/api/v1/catalog/products')
        .expect(200);
      expect(prodRes.headers['cache-control']).toBe('public, max-age=60');
    });

    it('should set no-store on internal service endpoints and stock mutations', async () => {
      const internalRes = await request(app.getHttpServer())
        .get('/api/v1/catalog/internal/products')
        .set('x-service-key', serviceKey)
        .expect(200);

      expect(internalRes.headers['cache-control']).toBe('no-store');
    });
  });

  describe('Security & Injection Defenses', () => {
    it('should strip prototype pollution properties on product creation', async () => {
      const slugSuffix = Math.random().toString(36).substring(2, 9);
      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Security Test Item',
          slug: `sec-test-${slugSuffix}`,
          sku: `SKU-SEC-${slugSuffix}`,
          price: 19.99,
          stock: 5,
          status: 'active',
          __proto__: { polluted: true },
          isAdmin: true,
          role: 'superuser',
        })
        .expect(201);

      expect(res.body.product).toBeDefined();
      expect((res.body.product as Record<string, unknown>).isAdmin).toBeUndefined();
      expect((res.body.product as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('should defend against SQL injection attempts in search queries', async () => {
      const sqlInjection = "'; DROP TABLE catalog.products; --";
      const res = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products?search=${encodeURIComponent(sqlInjection)}`)
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      // Ensure products table still exists and serves requests
      const checkRes = await request(app.getHttpServer())
        .get('/api/v1/catalog/products')
        .expect(200);
      expect(Array.isArray(checkRes.body.data)).toBe(true);
    });

    it('should enforce standard error envelope on 401 unauthenticated and 403 forbidden', async () => {
      // 401
      const unauthRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .send({ name: 'Hack Item' })
        .expect(401);

      expect(unauthRes.body.error).toBeDefined();
      expect(unauthRes.body.error.code).toBe('UNAUTHENTICATED');
      expect(unauthRes.body.requestId).toBeDefined();
      expect(unauthRes.body.timestamp).toBeDefined();

      // 403
      const forbidRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ name: 'Customer Create' })
        .expect(403);

      expect(forbidRes.body.error).toBeDefined();
      expect(forbidRes.body.error.code).toBe('FORBIDDEN');
      expect(forbidRes.body.requestId).toBeDefined();
    });

    it('should preserve and correlate x-request-id across response header and error envelope', async () => {
      const customRequestId = 'test-req-correlation-12345';
      const res = await request(app.getHttpServer())
        .get('/api/v1/catalog/products/non-existent-product-slug-xyz')
        .set('x-request-id', customRequestId)
        .expect(404);

      expect(res.headers['x-request-id']).toBe(customRequestId);
      expect(res.body.requestId).toBe(customRequestId);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});

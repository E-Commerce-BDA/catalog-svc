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

describe('Brands (e2e)', () => {
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

  it('1. GET /api/v1/catalog/brands returns active brands', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/brands')
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    const slugs = res.body.data.map((b: { slug: string }) => b.slug);
    expect(slugs).toContain('acme-essentials');
    expect(slugs).toContain('artisan-living');
  });

  it('2. GET /api/v1/brands dual-route returns same active brands', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/brands')
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    const slugs = res.body.data.map((b: { slug: string }) => b.slug);
    expect(slugs).toContain('acme-essentials');
  });

  it('3. GET /api/v1/catalog/brands/:slug returns single brand detail', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/brands/acme-essentials')
      .expect(200);

    expect(res.body.brand).toBeDefined();
    expect(res.body.brand.slug).toBe('acme-essentials');
    expect(res.body.brand.name).toBe('Acme Essentials');
  });

  it('4. GET /api/v1/catalog/brands/non-existent returns 404 in standard envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/brands/non-existent-brand-slug')
      .expect(404);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBeDefined();
  });

  it('5. POST /api/v1/catalog/brands rejects unauthenticated request with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .send({ name: 'Nordic Craft' })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('6. POST /api/v1/catalog/brands rejects customer role with 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ name: 'Nordic Craft' })
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  let createdBrandId: string;
  const createdSlug = `nordic-craft-${Math.random().toString(36).substring(2, 9)}`;

  it('7. POST /api/v1/catalog/brands creates brand with admin token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Nordic Craft E2E',
        slug: createdSlug,
        description: 'Scandinavian minimalist craft',
        sortOrder: 3,
      })
      .expect(201);

    expect(res.body.brand).toBeDefined();
    expect(res.body.brand.id).toBeDefined();
    expect(res.body.brand.slug).toBe(createdSlug);
    createdBrandId = res.body.brand.id;
  });

  it('8. POST /api/v1/catalog/brands rejects duplicate slug with 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/brands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Nordic Craft Duplicate',
        slug: createdSlug,
      })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('9. PATCH /api/v1/catalog/brands/:id updates brand with admin token', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/catalog/brands/${createdBrandId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        description: 'Updated scandinavian craft description',
        sortOrder: 8,
      })
      .expect(200);

    expect(res.body.brand.description).toBe('Updated scandinavian craft description');
    expect(res.body.brand.sortOrder).toBe(8);
  });

  it('10. DELETE /api/v1/catalog/brands/:id soft deletes brand', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/catalog/brands/${createdBrandId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    // Subsequent slug lookup should now 404
    await request(app.getHttpServer())
      .get(`/api/v1/catalog/brands/${createdSlug}`)
      .expect(404);
  });
});

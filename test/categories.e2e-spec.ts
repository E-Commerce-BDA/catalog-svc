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

describe('Categories (e2e)', () => {
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

  it('1. GET /api/v1/catalog/categories returns active categories', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/categories')
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    const slugs = res.body.data.map((c: { slug: string }) => c.slug);
    expect(slugs).toContain('apparel');
    expect(slugs).toContain('living');
  });

  it('2. GET /api/v1/categories dual-route returns same active categories', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    const slugs = res.body.data.map((c: { slug: string }) => c.slug);
    expect(slugs).toContain('apparel');
  });

  it('3. GET /api/v1/catalog/categories?navbar=true filters to navbar categories only', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/categories?navbar=true')
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    for (const cat of res.body.data) {
      expect(cat.showInNavbar).toBe(true);
      expect(cat.isActive).toBe(true);
    }
  });

  it('4. GET /api/v1/catalog/categories/tree returns hierarchical tree with children', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/categories/tree')
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    const apparel = res.body.data.find((c: { slug: string }) => c.slug === 'apparel');
    expect(apparel).toBeDefined();
    expect(Array.isArray(apparel.children)).toBe(true);
    const tshirts = apparel.children.find((c: { slug: string }) => c.slug === 't-shirts');
    expect(tshirts).toBeDefined();
  });

  it('5. GET /api/v1/catalog/categories/:slug returns single category detail', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/categories/apparel')
      .expect(200);

    expect(res.body.category).toBeDefined();
    expect(res.body.category.slug).toBe('apparel');
    expect(res.body.category.name).toBe('Apparel');
  });

  it('6. GET /api/v1/catalog/categories/non-existent returns 404 in standard envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/categories/non-existent-category-slug')
      .expect(404);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBeDefined();
  });

  it('7. POST /api/v1/catalog/categories rejects unauthenticated request with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .send({ name: 'Accessories' })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('8. POST /api/v1/catalog/categories rejects customer role with 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ name: 'Accessories' })
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  let createdCategoryId: string;
  const createdSlug = `accessories-${Math.random().toString(36).substring(2, 9)}`;

  it('9. POST /api/v1/catalog/categories creates category with admin token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Accessories E2E',
        slug: createdSlug,
        description: 'Bags, belts, and hats',
        showInNavbar: true,
        sortOrder: 5,
      })
      .expect(201);

    expect(res.body.category).toBeDefined();
    expect(res.body.category.id).toBeDefined();
    expect(res.body.category.slug).toBe(createdSlug);
    createdCategoryId = res.body.category.id;
  });

  it('10. POST /api/v1/catalog/categories rejects duplicate slug with 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Accessories Duplicate',
        slug: createdSlug,
      })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('11. PATCH /api/v1/catalog/categories/:id updates category with admin token', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/catalog/categories/${createdCategoryId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        description: 'Updated description for accessories',
        sortOrder: 10,
      })
      .expect(200);

    expect(res.body.category.description).toBe('Updated description for accessories');
    expect(res.body.category.sortOrder).toBe(10);
  });

  it('12. DELETE /api/v1/catalog/categories/:id soft deletes category', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/catalog/categories/${createdCategoryId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    // Subsequent slug lookup should now 404
    await request(app.getHttpServer())
      .get(`/api/v1/catalog/categories/${createdSlug}`)
      .expect(404);
  });
});

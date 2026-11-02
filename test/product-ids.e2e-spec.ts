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

/**
 * `ids` filter — the manual-curation read behind CMS
 * `featured_products source:"manual"` ("Most Popular"). The admin's list is a
 * filter first and an order second; the active-status floor never lifts for it.
 *
 * The suite creates its own products: the shared dev database accumulates
 * fixtures from every e2e file, so reading the seed by slug would page out.
 */
describe('Product ids filter (e2e)', () => {
  let app: INestApplication<App>;
  let adminToken: string;

  const suffix = Math.random().toString(36).substring(2, 8);
  let pickA: string; // active, first admin pick
  let pickB: string; // active, second admin pick
  let draftId: string; // draft — must never surface through ids

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

    const jwtService = app.get(JwtService);
    const secret = app
      .get(ConfigService)
      .getOrThrow<string>('JWT_SECRET');
    adminToken = await jwtService.signAsync(
      {
        sub: '0190a8b0-0000-7000-8000-000000000001',
        email: 'admin@example.com',
        roles: ['admin'],
      },
      { secret, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: JWT_ALGORITHM, expiresIn: '1h' },
    );

    const create = async (body: Record<string, unknown>) => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body)
        .expect(201);
      return res.body.product.id as string;
    };

    pickA = await create({
      sku: `IDS-A-${suffix}`,
      name: `Ids Pick A ${suffix}`,
      slug: `ids-pick-a-${suffix}`,
      price: 11,
      stock: 5,
      status: 'active',
    });
    pickB = await create({
      sku: `IDS-B-${suffix}`,
      name: `Ids Pick B ${suffix}`,
      slug: `ids-pick-b-${suffix}`,
      price: 22,
      stock: 5,
      status: 'active',
    });
    draftId = await create({
      sku: `IDS-D-${suffix}`,
      name: `Ids Draft ${suffix}`,
      slug: `ids-draft-${suffix}`,
      price: 33,
      stock: 5,
      status: 'draft',
    });
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it('1. returns exactly the requested ids in the submitted order', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?ids=${pickB},${pickA}`)
      .expect(200);

    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([pickB, pickA]);
  });

  it('2. repeated query params work like the comma form', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?ids=${pickA}&ids=${pickB}`)
      .expect(200);

    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([pickA, pickB]);
  });

  it('3. a draft id never leaks through the ids filter', async () => {
    const alone = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?ids=${draftId}`)
      .expect(200);
    expect(alone.body.data).toEqual([]);

    const mixed = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?ids=${draftId},${pickA}`)
      .expect(200);
    expect(mixed.body.data.map((p: { id: string }) => p.id)).toEqual([pickA]);
  });

  it('4. a malformed id is rejected with 400, not ignored', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/products?ids=11111111-1111-4111-8111-11111111111Z')
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('5. more than 24 ids are rejected', async () => {
    const ids = Array.from({ length: 25 }, () => pickA).join(',');
    await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?ids=${ids}`)
      .expect(400);
  });

  it('6. an unknown-but-valid id is simply absent (no 500, no empty page)', async () => {
    const res = await request(app.getHttpServer())
      .get(
        `/api/v1/catalog/products?ids=99999999-9999-4999-8999-999999999999,${pickA}`,
      )
      .expect(200);
    // A well-formed UUID the catalog has never seen must behave like an
    // unmet admin pick: dropped quietly, the existing row still renders.
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([pickA]);
  });

  it('7. ids compose with sort: an explicit sort wins over the submitted order', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?ids=${pickA},${pickB}&sort=price_asc`)
      .expect(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([pickA, pickB]);

    const desc = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?ids=${pickA},${pickB}&sort=price_desc`)
      .expect(200);
    expect(desc.body.data.map((p: { id: string }) => p.id)).toEqual([pickB, pickA]);
  });
});

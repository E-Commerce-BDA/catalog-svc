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

describe('Products & PDP (e2e)', () => {
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

  it('1. GET /api/v1/catalog/products lists active products and excludes archived', async () => {
    // 100 is the maximum page size: the shared database keeps accumulating
    // fixtures from other e2e files, which would push the seeds off page 1.
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/products?limit=100')
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    const slugs = res.body.data.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain('fixture-tee');
    expect(slugs).toContain('fixture-mug');
    expect(slugs).not.toContain('discontinued-lamp');
  });

  it('2. GET /api/v1/products dual route functions identically', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/products?limit=100')
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    const slugs = res.body.data.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain('fixture-tee');
  });

  it('3. GET /api/v1/catalog/products filters by price and sort', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/products?minPrice=50&sort=price_asc')
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    for (const item of res.body.data) {
      expect(item.price).toBeGreaterThanOrEqual(50);
    }
  });

  it('4. GET /api/v1/catalog/products/:slug returns rich PDP in single roundtrip', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/products/fixture-tee')
      .expect(200);

    const product = res.body.product;
    expect(product).toBeDefined();
    expect(product.sku).toBe('TEE-MAIN');
    expect(product.name).toBe('Fixture Tee');
    expect(product.category).toMatchObject({
      name: 'T-Shirts',
      slug: 't-shirts',
    });
    expect(product.brand).toMatchObject({
      name: 'Acme Essentials',
      slug: 'acme-essentials',
    });
    expect(Array.isArray(product.images)).toBe(true);
    expect(product.images.length).toBeGreaterThanOrEqual(1);

    expect(Array.isArray(product.options)).toBe(true);
    expect(product.options.length).toBe(2); // Color and Size

    expect(Array.isArray(product.variants)).toBe(true);
    expect(product.variants.length).toBe(2); // TEE-BLK-M and TEE-WHT-L

    const blackM = product.variants.find((v: { sku: string }) => v.sku === 'TEE-BLK-M');
    expect(blackM).toBeDefined();
    expect(Array.isArray(blackM.options)).toBe(true);
    expect(blackM.options.length).toBe(2);
  });

  it('5. GET /api/v1/catalog/products/id/:id returns rich PDP by UUID', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/products/id/0190a8b0-0000-7000-8000-000000000101')
      .expect(200);

    expect(res.body.product).toBeDefined();
    expect(res.body.product.slug).toBe('fixture-tee');
  });

  it('6. POST /api/v1/catalog/products rejects unauthenticated with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .send({ sku: 'NEW-1', name: 'Product 1', price: 10 })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('7. POST /api/v1/catalog/products rejects customer with 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ sku: 'NEW-1', name: 'Product 1', price: 10 })
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  let createdProdId: string;
  const uniqueSuffix = Math.random().toString(36).substring(2, 8);
  const newSku = `SKU-${uniqueSuffix}`;
  const newSlug = `slug-${uniqueSuffix}`;

  it('8. POST /api/v1/catalog/products creates product with admin token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: newSku,
        name: 'Brand New Product',
        slug: newSlug,
        price: 49.99,
        compareAtPrice: 59.99,
        stock: 25,
        status: 'active',
      })
      .expect(201);

    expect(res.body.product).toBeDefined();
    expect(res.body.product.id).toBeDefined();
    expect(res.body.product.sku).toBe(newSku);
    createdProdId = res.body.product.id;
  });

  it('9. POST /api/v1/catalog/products rejects duplicate SKU with 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: newSku,
        name: 'Duplicate SKU Product',
        price: 30,
      })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('10. PATCH /api/v1/catalog/products/:id updates product', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/catalog/products/${createdProdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        price: 44.99,
        description: 'Updated product description',
      })
      .expect(200);

    expect(res.body.product.price).toBe(44.99);
    expect(res.body.product.description).toBe('Updated product description');
  });

  let createdVariantId: string;

  it('11. POST /api/v1/catalog/products/:id/variants creates variant', async () => {
    const variantSku = `VAR-${uniqueSuffix}-1`;
    const res = await request(app.getHttpServer())
      .post(`/api/v1/catalog/products/${createdProdId}/variants`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: variantSku,
        price: 44.99,
        stock: 15,
      })
      .expect(201);

    expect(res.body.variant).toBeDefined();
    expect(res.body.variant.sku).toBe(variantSku);
    createdVariantId = res.body.variant.id;
  });

  it('12. PATCH /api/v1/catalog/variants/:id updates variant', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/catalog/variants/${createdVariantId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        stock: 20,
      })
      .expect(200);

    expect(res.body.variant.stock).toBe(20);
  });

  let createdImageId: string;

  it('13. POST /api/v1/catalog/products/:id/images creates image', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/catalog/products/${createdProdId}/images`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        url: 'https://example.com/test-image.jpg',
        alt: 'Test Alt',
        isPrimary: true,
      })
      .expect(201);

    expect(res.body.image).toBeDefined();
    expect(res.body.image.url).toBe('https://example.com/test-image.jpg');
    createdImageId = res.body.image.id;
  });

  it('14. DELETE /api/v1/catalog/images/:id deletes image', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/catalog/images/${createdImageId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
  });

  let createdDiscountId: string;

  it('15. POST /api/v1/catalog/products/:id/discounts creates discount', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/catalog/products/${createdProdId}/discounts`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        discountType: 'percent',
        value: 10,
        startsAt: new Date(Date.now() - 3600000).toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
      })
      .expect(201);

    expect(res.body.discount).toBeDefined();
    expect(res.body.discount.value).toBe(10);
    createdDiscountId = res.body.discount.id;

    // Verify PDP now reflects active discount and effective price
    const pdp = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${newSlug}`)
      .expect(200);

    expect(pdp.body.product.activeDiscount).toBeDefined();
    expect(pdp.body.product.effectivePrice).toBeLessThan(44.99);
  });

  it('16. DELETE /api/v1/catalog/discounts/:id deletes discount', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/catalog/discounts/${createdDiscountId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
  });

  it('17. DELETE /api/v1/catalog/products/:id soft deletes product', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/catalog/products/${createdProdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    // Subsequent PDP query should now 404
    await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${newSlug}`)
      .expect(404);
  });
});

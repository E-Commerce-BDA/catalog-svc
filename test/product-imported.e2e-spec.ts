import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { closePool, getPool } from './../src/db/pool.js';
import { ConsumerMetrics } from './../src/events/consumer-metrics.js';
import { ProductImportRejectedError } from './../src/events/product-imported/import.errors.js';
import { ProductImportedHandler } from './../src/events/product-imported/product-imported.handler.js';
import { StockReservationsRepository } from './../src/stock/stock-reservations.repository.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  slug: string;
  price: string;
  stock: number;
  status: string;
  source: string;
  external_id: string | null;
  category_id: string | null;
  brand_id: string | null;
  tags: string[] | null;
  attributes: Record<string, unknown>;
  photo_settings: Record<string, unknown>;
  card_settings: Record<string, unknown>;
}

/**
 * `product.imported` against Postgres, without a broker.
 *
 * The handler is the only thing between a Kafka record and the transaction, so
 * calling it directly proves every rule `cat-008` added: the upsert by id, the
 * findBy/create by slug, the stock formula, one `import` movement per figure,
 * the image replace-set and the four dead-letter reasons.
 */
describe('product.imported consumer (e2e)', () => {
  let app: INestApplication<App>;
  let handler: ProductImportedHandler;
  let reservations: StockReservationsRepository;
  let metrics: ConsumerMetrics;

  const productIds: string[] = [];
  const categoryIds: string[] = [];
  const brandIds: string[] = [];
  const reservationIds: string[] = [];
  const eventIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', { exclude: ['health', 'health/ready'] });
    await app.init();

    handler = app.get(ProductImportedHandler);
    reservations = app.get(StockReservationsRepository);
    metrics = app.get(ConsumerMetrics);
  });

  afterAll(async () => {
    const pool = getPool();

    if (productIds.length > 0) {
      await pool.query(
        `DELETE FROM catalog.stock_movements WHERE product_id = ANY($1::uuid[])`,
        [productIds],
      );
      await pool.query(
        `DELETE FROM catalog.products WHERE id = ANY($1::uuid[])`,
        [productIds],
      );
    }
    if (reservationIds.length > 0) {
      await pool.query(
        `DELETE FROM catalog.stock_reservations WHERE id = ANY($1::uuid[])`,
        [reservationIds],
      );
    }
    if (categoryIds.length > 0) {
      await pool.query(`DELETE FROM catalog.categories WHERE id = ANY($1::uuid[])`, [
        categoryIds,
      ]);
    }
    if (brandIds.length > 0) {
      await pool.query(`DELETE FROM catalog.brands WHERE id = ANY($1::uuid[])`, [
        brandIds,
      ]);
    }
    if (eventIds.length > 0) {
      await pool.query(
        `DELETE FROM catalog.processed_events WHERE event_id = ANY($1::varchar[])`,
        [eventIds],
      );
    }

    metrics.reset();
    await app.close();
    await closePool();
  });

  /** A unique payload per test, so nothing depends on seeded catalog data. */
  function payloadFor(
    productId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const suffix = productId.slice(0, 8);
    return {
      productId,
      sku: `IMP-${suffix}`,
      name: `Imported ${suffix}`,
      slug: `imported-${suffix}`,
      description: 'From the feed',
      price: 19.99,
      stock: 5,
      status: 'active',
      updatedAt: '2026-10-30T10:00:00.000Z',
      ...overrides,
    };
  }

  function eventFor(payload: Record<string, unknown>): {
    id: string;
    type: string;
    producer: string;
    timestamp: string;
    payload: Record<string, unknown>;
  } {
    const id = randomUUID();
    eventIds.push(id);
    return {
      id,
      type: 'product.imported',
      producer: 'import-svc',
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  function trackProduct(): string {
    const id = randomUUID();
    productIds.push(id);
    return id;
  }

  async function productRow(id: string): Promise<ProductRow | undefined> {
    const { rows } = await getPool().query<ProductRow>(
      `SELECT id, sku, name, slug, price, stock, status, source, external_id,
              category_id, brand_id, tags, attributes, photo_settings, card_settings
         FROM catalog.products WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function variants(productId: string): Promise<
    { sku: string; price: string; stock: number; is_active: boolean }[]
  > {
    const { rows } = await getPool().query<{
      sku: string;
      price: string;
      stock: number;
      is_active: boolean;
    }>(
      `SELECT sku, price, stock, is_active FROM catalog.product_variants
        WHERE product_id = $1 ORDER BY sku`,
      [productId],
    );
    return rows;
  }

  async function images(
    productId: string,
  ): Promise<{ url: string; sort_order: number; is_primary: boolean }[]> {
    const { rows } = await getPool().query<{
      url: string;
      sort_order: number;
      is_primary: boolean;
    }>(
      `SELECT url, sort_order, is_primary FROM catalog.product_images
        WHERE product_id = $1 ORDER BY sort_order`,
      [productId],
    );
    return rows;
  }

  async function importMovements(
    productId: string,
  ): Promise<{ variant_id: string | null; qty_change: number; qty_after: number }[]> {
    const { rows } = await getPool().query<{
      variant_id: string | null;
      qty_change: number;
      qty_after: number;
    }>(
      `SELECT variant_id, qty_change, qty_after FROM catalog.stock_movements
        WHERE product_id = $1 AND reason = 'import'
        ORDER BY variant_id NULLS FIRST`,
      [productId],
    );
    return rows;
  }

  async function outboxCount(): Promise<number> {
    const { rows } = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.outbox`,
    );
    return rows[0].count;
  }

  async function claimCount(eventId: string): Promise<number> {
    const { rows } = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.processed_events
        WHERE event_id = $1`,
      [eventId],
    );
    return rows[0].count;
  }

  it('creates the product, its variants and its images in one transaction, with no outbox row', async () => {
    const productId = trackProduct();
    const outboxBefore = await outboxCount();
    const event = eventFor(
      payloadFor(productId, {
        images: ['/uploads/one.jpg', '/uploads/two.jpg', '/uploads/three.jpg'],
        variants: [
          { sku: `IMP-${productId.slice(0, 8)}-RED`, price: 20, stock: 2 },
          { sku: `IMP-${productId.slice(0, 8)}-BLUE`, price: '21.50', stock: 3 },
        ],
      }),
    );

    await expect(handler.handle(event)).resolves.toMatchObject({
      kind: 'applied',
      productId,
      created: true,
      variants: 2,
      images: 3,
    });

    const row = await productRow(productId);
    expect(row).toMatchObject({
      status: 'active',
      // The migration this task needed: 001's CHECK did not allow 'import'.
      source: 'import',
      stock: 5,
      external_id: null,
    });
    expect(Number(row?.price)).toBe(19.99);

    expect(await variants(productId)).toEqual([
      { sku: `IMP-${productId.slice(0, 8)}-BLUE`, price: '21.50', stock: 3, is_active: true },
      { sku: `IMP-${productId.slice(0, 8)}-RED`, price: '20.00', stock: 2, is_active: true },
    ]);

    const stored = await images(productId);
    expect(stored).toEqual([
      { url: '/uploads/one.jpg', sort_order: 0, is_primary: true },
      { url: '/uploads/two.jpg', sort_order: 1, is_primary: false },
      { url: '/uploads/three.jpg', sort_order: 2, is_primary: false },
    ]);

    expect(await claimCount(event.id)).toBe(1);
    // D2: the index learns about this from product.imported itself, so the
    // import must not also queue 10 000 product.updated events.
    expect(await outboxCount()).toBe(outboxBefore);

    // One figure stated per row: the product plus each variant.
    const movements = await importMovements(productId);
    expect(movements).toHaveLength(3);
    expect(movements[0]).toEqual({ variant_id: null, qty_change: 5, qty_after: 5 });
  });

  it('writes nothing when the same event id is delivered twice', async () => {
    const productId = trackProduct();
    const event = eventFor(payloadFor(productId));
    const first = await handler.handle(event);
    const movementsBefore = (await importMovements(productId)).length;

    await expect(handler.handle(event)).resolves.toEqual({
      kind: 'duplicate',
      eventId: event.id,
    });

    expect(first).toMatchObject({ kind: 'applied' });
    expect(await claimCount(event.id)).toBe(1);
    expect(await productRow(productId)).toMatchObject({ stock: 5 });
    expect(await importMovements(productId)).toHaveLength(movementsBefore);
  });

  it('updates an existing product without rewriting provenance or presentation', async () => {
    const productId = trackProduct();
    const sku = `LOCAL-${productId.slice(0, 8)}`;
    const slug = `local-${productId.slice(0, 8)}`;

    await getPool().query(
      `INSERT INTO catalog.products (
         id, sku, name, slug, price, stock, status, source, external_id,
         tags, attributes, photo_settings, card_settings
       ) VALUES ($1, $2, 'Local Product', $3, 10, 4, 'active', 'shopify',
                 'shopify-123', ARRAY['sale'], '{"color":"red"}'::jsonb,
                 '{"ratio":"3:2"}'::jsonb, '{"layout":"wide"}'::jsonb)`,
      [productId, sku, slug],
    );

    await handler.handle(
      eventFor(
        payloadFor(productId, {
          sku,
          slug,
          name: 'Renamed By Feed',
          price: 24.5,
          stock: 9,
        }),
      ),
    );

    const row = await productRow(productId);
    expect(row).toMatchObject({
      name: 'Renamed By Feed',
      slug,
      sku,
      stock: 9,
      // The import states what the product is, never where it came from or how
      // it looks.
      source: 'shopify',
      external_id: 'shopify-123',
      tags: ['sale'],
      attributes: { color: 'red' },
      photo_settings: { ratio: '3:2' },
      card_settings: { layout: 'wide' },
    });
    expect(Number(row?.price)).toBe(24.5);
  });

  it('rejects a categoryId that does not exist and leaves the event unclaimed', async () => {
    const productId = trackProduct();
    const event = eventFor(
      payloadFor(productId, { categoryId: randomUUID() }),
    );

    await expect(handler.handle(event)).rejects.toMatchObject({
      reason: 'unresolved-reference',
    });

    // The claim shares the transaction, so a rejected import leaves no trace:
    // the DLQ is the only record.
    expect(await claimCount(event.id)).toBe(0);
    expect(await productRow(productId)).toBeUndefined();
  });

  it('creates the category and the brand a feed names but the catalog lacks', async () => {
    const productId = trackProduct();
    const categorySlug = `Spring-${productId.slice(0, 8)}`;
    const brandName = `Acme ${productId.slice(0, 8)}`;

    await handler.handle(
      eventFor(payloadFor(productId, { categorySlug, brandName })),
    );

    const row = await productRow(productId);
    expect(row?.category_id).toBeTruthy();
    expect(row?.brand_id).toBeTruthy();
    categoryIds.push(row!.category_id!);
    brandIds.push(row!.brand_id!);

    const { rows: categories } = await getPool().query<{
      name: string;
      slug: string;
      is_active: boolean;
    }>(`SELECT name, slug, is_active FROM catalog.categories WHERE id = $1`, [
      row!.category_id,
    ]);
    expect(categories[0]).toEqual({
      name: categorySlug,
      slug: categorySlug.toLowerCase(),
      is_active: true,
    });

    // A second import naming the same brand reuses the row instead of failing on
    // the unique slug.
    const other = trackProduct();
    await handler.handle(
      eventFor(payloadFor(other, { brandName, categorySlug })),
    );
    expect((await productRow(other))?.brand_id).toBe(row!.brand_id);
  });

  it('dead-letters a sku that belongs to another product', async () => {
    const ownerId = trackProduct();
    await handler.handle(eventFor(payloadFor(ownerId)));
    const owner = await productRow(ownerId);

    const intruderId = trackProduct();
    const event = eventFor(
      payloadFor(intruderId, { sku: owner!.sku }),
    );

    await expect(handler.handle(event)).rejects.toBeInstanceOf(
      ProductImportRejectedError,
    );
    await expect(handler.handle(event)).rejects.toMatchObject({
      reason: 'sku-conflict',
    });
    expect(await productRow(intruderId)).toBeUndefined();
  });

  it('dead-letters a slug that belongs to another product', async () => {
    const ownerId = trackProduct();
    await handler.handle(eventFor(payloadFor(ownerId)));
    const owner = await productRow(ownerId);

    const intruderId = trackProduct();

    await expect(
      handler.handle(eventFor(payloadFor(intruderId, { slug: owner!.slug }))),
    ).rejects.toMatchObject({ reason: 'slug-conflict' });
    expect(await productRow(intruderId)).toBeUndefined();
  });

  it('dead-letters a variant sku that belongs to another product', async () => {
    const ownerId = trackProduct();
    const sku = `IMP-${ownerId.slice(0, 8)}-SHARED`;
    await handler.handle(
      eventFor(
        payloadFor(ownerId, { variants: [{ sku, price: 10, stock: 1 }] }),
      ),
    );

    const intruderId = trackProduct();

    await expect(
      handler.handle(
        eventFor(
          payloadFor(intruderId, { variants: [{ sku, price: 10, stock: 1 }] }),
        ),
      ),
    ).rejects.toMatchObject({ reason: 'variant-sku-conflict' });
    expect(await productRow(intruderId)).toBeUndefined();
  });

  it('reports physical stock net of live holds, as one import movement', async () => {
    const productId = trackProduct();
    await handler.handle(eventFor(payloadFor(productId, { stock: 10 })));
    expect((await productRow(productId))?.stock).toBe(10);

    // A shopper holds 2 of the 10: the row now says 8 on hand.
    const reservationId = randomUUID();
    reservationIds.push(reservationId);
    await reservations.reserve(reservationId, [{ productId, quantity: 2 }], 900);
    expect((await productRow(productId))?.stock).toBe(8);

    const event = eventFor(payloadFor(productId, { stock: 10 }));
    await handler.handle(event);

    // The feed said 10 *physical*; 2 are held, so 8 remains available — the
    // import must not overwrite the live hold out of existence.
    expect((await productRow(productId))?.stock).toBe(8);

    const movements = await importMovements(productId);
    // Exactly one row per import that stated a figure, including the assertion
    // that changed nothing.
    expect(movements).toHaveLength(2);
    expect(movements[1]).toEqual({ variant_id: null, qty_change: 0, qty_after: 8 });
  });

  it('clamps on-hand stock to zero when the feed reports fewer units than are held', async () => {
    const productId = trackProduct();
    await handler.handle(eventFor(payloadFor(productId, { stock: 10 })));

    const reservationId = randomUUID();
    reservationIds.push(reservationId);
    await reservations.reserve(reservationId, [{ productId, quantity: 5 }], 900);

    await handler.handle(eventFor(payloadFor(productId, { stock: 3 })));

    expect((await productRow(productId))?.stock).toBe(0);

    const movements = await importMovements(productId);
    expect(movements[1]).toEqual({ variant_id: null, qty_change: -5, qty_after: 0 });
  });

  it('replaces the image set while keeping exactly one primary', async () => {
    const productId = trackProduct();
    await handler.handle(
      eventFor(
        payloadFor(productId, { images: ['/uploads/a.jpg', '/uploads/b.jpg'] }),
      ),
    );

    await handler.handle(
      eventFor(
        payloadFor(productId, { images: ['/uploads/b.jpg', '/uploads/c.jpg'] }),
      ),
    );

    expect(await images(productId)).toEqual([
      { url: '/uploads/b.jpg', sort_order: 0, is_primary: true },
      { url: '/uploads/c.jpg', sort_order: 1, is_primary: false },
    ]);
  });

  it('never deletes a variant for being absent from the payload', async () => {
    const productId = trackProduct();
    const variantSku = `IMP-${productId.slice(0, 8)}-KEEP`;
    await handler.handle(
      eventFor(
        payloadFor(productId, {
          variants: [{ sku: variantSku, price: 10, stock: 1 }],
        }),
      ),
    );

    // Absence is ambiguous — a partial feed, not a withdrawal.
    await handler.handle(eventFor(payloadFor(productId, { name: 'Renamed' })));

    expect(await variants(productId)).toHaveLength(1);
    expect((await productRow(productId))?.name).toBe('Renamed');
  });

  it('keeps an archived product archived when the feed calls it inactive', async () => {
    const productId = trackProduct();
    await handler.handle(eventFor(payloadFor(productId, { status: 'active' })));
    await getPool().query(
      `UPDATE catalog.products SET status = 'archived' WHERE id = $1`,
      [productId],
    );

    await handler.handle(
      eventFor(payloadFor(productId, { status: 'inactive' })),
    );

    expect((await productRow(productId))?.status).toBe('archived');
  });

  it('writes no stock movement when the payload carries no stock figure', async () => {
    const productId = trackProduct();
    const payload = payloadFor(productId);
    delete payload.stock;

    await handler.handle(eventFor(payload));

    expect((await productRow(productId))?.stock).toBe(0);
    expect(await importMovements(productId)).toHaveLength(0);
  });
});

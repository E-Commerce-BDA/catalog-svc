import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { closePool, getPool } from '../src/db/pool.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

describe('Catalog Schema (e2e)', () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getPool().connect();
    await client.query('BEGIN');
  });

  beforeEach(async () => {
    await client.query('SAVEPOINT test_sp');
  });

  afterEach(async () => {
    await client.query('ROLLBACK TO SAVEPOINT test_sp');
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await closePool();
  });

  it('1. all 17 base tables exist in catalog schema', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name 
       FROM information_schema.tables 
       WHERE table_schema = 'catalog' AND table_type = 'BASE TABLE'
       ORDER BY table_name;`,
    );

    const tableNames = rows.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'badges',
      'brands',
      'categories',
      'processed_events',
      'product_attribute_values',
      'product_attributes',
      'product_badges',
      'product_discounts',
      'product_images',
      'product_option_values',
      'product_options',
      'product_variant_option_values',
      'product_variants',
      'products',
      'reviews',
      'stock_movements',
      'stock_reservations',
    ]);
  });

  it('2. all required indexes exist in catalog schema', async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname 
       FROM pg_indexes 
       WHERE schemaname = 'catalog';`,
    );

    const indexNames = rows.map((r) => r.indexname);
    const expectedIndexes = [
      'idx_categories_parent_id',
      'idx_categories_search_vector',
      'idx_categories_navbar',
      'idx_brands_active',
      'idx_products_category_id',
      'idx_products_brand_id',
      'idx_products_search_vector',
      'idx_products_active',
      'idx_products_tags',
      'products_source_external_key',
      'idx_products_active_price',
      'idx_product_variants_product_id',
      'idx_product_variants_active',
      'idx_product_images_product_order',
      'idx_product_images_variant_id',
      'one_primary_per_product',
      'idx_product_options_product_id',
      'values_per_option_unique',
      'idx_pvov_option_value_id',
      'idx_pvov_option_id',
      'pav_product_attr_unique',
      'idx_pav_attribute_id',
      'idx_stock_movements_product_time',
      'idx_stock_movements_created_at',
      'idx_stock_movements_reservation',
      'idx_stock_reservations_order',
      'idx_stock_reservations_due',
      'idx_catalog_processed_events_processed_at',
      'idx_product_discounts_active',
      'idx_discounts_active_range',
      'idx_reviews_product_approved',
      'idx_reviews_user_id',
      'idx_badges_active',
      'idx_product_badges_lookup',
    ];

    for (const expected of expectedIndexes) {
      expect(indexNames).toContain(expected);
    }
  });

  it('3. enforces unique slug on categories', async () => {
    const slug = `cat-${randomUUID()}`;
    await client.query(
      `INSERT INTO catalog.categories (name, slug) VALUES ('Cat 1', $1)`,
      [slug],
    );

    await expect(
      client.query(
        `INSERT INTO catalog.categories (name, slug) VALUES ('Cat 2', $1)`,
        [slug],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('4. enforces unique slug on brands', async () => {
    const slug = `brand-${randomUUID()}`;
    await client.query(
      `INSERT INTO catalog.brands (name, slug) VALUES ('Brand 1', $1)`,
      [slug],
    );

    await expect(
      client.query(
        `INSERT INTO catalog.brands (name, slug) VALUES ('Brand 2', $1)`,
        [slug],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('5. enforces products status check enum', async () => {
    await expect(
      client.query(`
        INSERT INTO catalog.products (sku, name, slug, price, stock, status)
        VALUES ('TEST-SKU-1', 'Test Product', 'test-product', 10.00, 5, 'invalid_status')
      `),
    ).rejects.toThrow(/violates check constraint "products_status_check"/);
  });

  it('6. enforces products price >= 0 check constraint', async () => {
    await expect(
      client.query(`
        INSERT INTO catalog.products (sku, name, slug, price, stock, status)
        VALUES ('TEST-SKU-2', 'Negative Price', 'negative-price', -5.00, 5, 'active')
      `),
    ).rejects.toThrow(/violates check constraint "products_price_check"/);
  });

  it('7. enforces unique product SKU', async () => {
    const sku = `SKU-${randomUUID().slice(0, 8)}`;
    await client.query(
      `INSERT INTO catalog.products (sku, name, slug, price, stock, status)
       VALUES ($1, 'Prod 1', 'unique-slug-1', 25.00, 10, 'active')`,
      [sku],
    );

    await expect(
      client.query(
        `INSERT INTO catalog.products (sku, name, slug, price, stock, status)
         VALUES ($1, 'Prod 2', 'unique-slug-2', 25.00, 10, 'active')`,
        [sku],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('8. enforces unique product slug', async () => {
    const slug = `slug-${randomUUID()}`;
    await client.query(
      `INSERT INTO catalog.products (sku, name, slug, price, stock, status)
       VALUES ('SKU-DIFF-1', 'Prod 1', $1, 25.00, 10, 'active')`,
      [slug],
    );

    await expect(
      client.query(
        `INSERT INTO catalog.products (sku, name, slug, price, stock, status)
         VALUES ('SKU-DIFF-2', 'Prod 2', $1, 25.00, 10, 'active')`,
        [slug],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('9. enforces reviews rating between 1 and 5', async () => {
    const { rows: prodRows } = await client.query<{ id: string }>(
      `SELECT id FROM catalog.products LIMIT 1;`,
    );
    const productId = prodRows[0].id;
    const userId = randomUUID();

    // Rating 0 should fail
    await expect(
      client.query(`
        INSERT INTO catalog.reviews (product_id, user_id, rating, title, body, is_approved)
        VALUES ('${productId}', '${userId}', 0, 'Bad', 'Content', true)
      `),
    ).rejects.toThrow(/violates check constraint "reviews_rating_check"/);

    // Rating 6 should fail
    await client.query('ROLLBACK TO SAVEPOINT test_sp');
    await client.query('SAVEPOINT test_sp');

    await expect(
      client.query(`
        INSERT INTO catalog.reviews (product_id, user_id, rating, title, body, is_approved)
        VALUES ('${productId}', '${userId}', 6, 'Great', 'Content', true)
      `),
    ).rejects.toThrow(/violates check constraint "reviews_rating_check"/);
  });

  it('10. enforces product discounts type and bounds check', async () => {
    const { rows: prodRows } = await client.query<{ id: string }>(
      `SELECT id FROM catalog.products LIMIT 1;`,
    );
    const productId = prodRows[0].id;

    // Invalid discount type
    await expect(
      client.query(`
        INSERT INTO catalog.product_discounts (product_id, discount_type, value, starts_at, ends_at)
        VALUES ('${productId}', 'bogo', 10, now(), now() + interval '1 day')
      `),
    ).rejects.toThrow(
      /violates check constraint "product_discounts_type_check"/,
    );

    await client.query('ROLLBACK TO SAVEPOINT test_sp');
    await client.query('SAVEPOINT test_sp');

    // Percent > 100 should fail
    await expect(
      client.query(`
        INSERT INTO catalog.product_discounts (product_id, discount_type, value, starts_at, ends_at)
        VALUES ('${productId}', 'percent', 105, now(), now() + interval '1 day')
      `),
    ).rejects.toThrow(
      /violates check constraint "product_discounts_value_check"/,
    );
  });

  it('11. enforces stock movements reason check', async () => {
    const { rows: prodRows } = await client.query<{ id: string }>(
      `SELECT id FROM catalog.products LIMIT 1;`,
    );
    const productId = prodRows[0].id;

    await expect(
      client.query(`
        INSERT INTO catalog.stock_movements (product_id, qty_change, reason, qty_after)
        VALUES ('${productId}', 10, 'magic_addition', 10)
      `),
    ).rejects.toThrow(
      /violates check constraint "stock_movements_reason_check"/,
    );
  });

  it('12. verifies updated_at trigger updates timestamp on modified product', async () => {
    const { rows: prodRows } = await client.query<{
      id: string;
      updated_at: string;
    }>(`SELECT id, updated_at FROM catalog.products LIMIT 1;`);
    const productId = prodRows[0].id;
    const originalUpdatedAt = new Date(prodRows[0].updated_at).getTime();

    // Small delay to ensure timestamp difference in PostgreSQL
    await new Promise((resolve) => setTimeout(resolve, 50));

    await client.query(
      `UPDATE catalog.products SET name = 'Updated Fixture Name' WHERE id = $1`,
      [productId],
    );

    const { rows: updatedRows } = await client.query<{ updated_at: string }>(
      `SELECT updated_at FROM catalog.products WHERE id = $1;`,
      [productId],
    );
    const newUpdatedAt = new Date(updatedRows[0].updated_at).getTime();

    expect(newUpdatedAt).toBeGreaterThan(originalUpdatedAt);
  });

  it('13. verifies partial index idx_categories_navbar is active and defined', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes 
       WHERE schemaname = 'catalog' AND indexname = 'idx_categories_navbar';`,
    );

    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toContain('WHERE (is_active AND show_in_navbar)');
  });

  it('14. verifies partial index idx_products_active is active and defined', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes 
       WHERE schemaname = 'catalog' AND indexname = 'idx_products_active';`,
    );

    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toContain(
      "WHERE ((status)::text = 'active'::text)",
    );
  });

  it('15. enforces one reservation per order but leaves null order ids unconstrained', async () => {
    const orderId = randomUUID();
    const insert = `INSERT INTO catalog.stock_reservations (id, order_id, status, expires_at)
                    VALUES ($1::uuid, $2::uuid, 'held', now() + interval '15 minutes')`;

    await client.query(insert, [randomUUID(), orderId]);

    // A failed statement aborts the enclosing test transaction, so isolate it.
    await client.query('SAVEPOINT conflict_sp');
    await expect(client.query(insert, [randomUUID(), orderId])).rejects.toThrow(
      /idx_stock_reservations_order/,
    );
    await client.query('ROLLBACK TO SAVEPOINT conflict_sp');

    // Checkout reserves before the order exists, so several null order ids must
    // be allowed (the partial predicate is `WHERE order_id IS NOT NULL`).
    await client.query(insert, [randomUUID(), null]);
    await client.query(insert, [randomUUID(), null]);
  });

  it('16. exposes stock_movements.reservation_id', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'catalog'
         AND table_name = 'stock_movements'
         AND column_name = 'reservation_id';`,
    );

    expect(rows).toHaveLength(1);
  });

  it('17. enforces unique key on badges and valid foreign key on product_badges', async () => {
    const badgeKey = `badge-${randomUUID().slice(0, 8)}`;
    const { rows: badgeRows } = await client.query<{ id: string }>(
      `INSERT INTO catalog.badges (key, label, bg, text_color)
       VALUES ($1, 'Test Badge', '#ff0000', '#ffffff')
       RETURNING id;`,
      [badgeKey],
    );
    const badgeId = badgeRows[0].id;

    // Unique key check
    await client.query('SAVEPOINT badge_key_sp');
    await expect(
      client.query(
        `INSERT INTO catalog.badges (key, label, bg, text_color)
         VALUES ($1, 'Dup Badge', '#ff0000', '#ffffff');`,
        [badgeKey],
      ),
    ).rejects.toThrow();
    await client.query('ROLLBACK TO SAVEPOINT badge_key_sp');

    // Create a product and assign badge
    const pSlug = `prod-${randomUUID()}`;
    const pSku = `SKU-${randomUUID().slice(0, 8)}`;
    const { rows: pRows } = await client.query<{ id: string }>(
      `INSERT INTO catalog.products (sku, name, slug, price, status)
       VALUES ($1, 'Test Product', $2, 99.99, 'active')
       RETURNING id;`,
      [pSku, pSlug],
    );
    const productId = pRows[0].id;

    await client.query(
      `INSERT INTO catalog.product_badges (product_id, badge_id, sort_order)
       VALUES ($1, $2, 1);`,
      [productId, badgeId],
    );

    const { rows: assigned } = await client.query(
      `SELECT * FROM catalog.product_badges WHERE product_id = $1 AND badge_id = $2;`,
      [productId, badgeId],
    );
    expect(assigned).toHaveLength(1);
  });

  it('18. exposes products.card_settings jsonb column', async () => {
    const { rows } = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'catalog'
         AND table_name = 'products'
         AND column_name = 'card_settings';`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('jsonb');
  });

  it('19. exposes product_options and product_option_values swatch columns', async () => {
    const { rows: optCols } = await client.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'catalog'
         AND table_name = 'product_options'
         AND column_name IN ('display_type', 'show_on_card');`,
    );
    expect(optCols).toHaveLength(2);

    const { rows: valCols } = await client.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'catalog'
         AND table_name = 'product_option_values'
         AND column_name IN ('swatch_hex', 'swatch_image_url');`,
    );
    expect(valCols).toHaveLength(2);
  });

  it('20. exposes product_options.card_placement with check constraint', async () => {
    const { rows: colRows } = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'catalog'
         AND table_name = 'product_options'
         AND column_name = 'card_placement';`,
    );
    expect(colRows).toHaveLength(1);
    expect(colRows[0].data_type).toBe('character varying');

    const { rows: prodRows } = await client.query<{ id: string }>(
      `SELECT id FROM catalog.products LIMIT 1;`,
    );
    const productId = prodRows[0].id;

    // Verify valid placement succeeds
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO catalog.product_options (product_id, name, display_type, card_placement, position)
       VALUES ($1, 'Placement Test', 'pill', 'brand-hover', 99)
       RETURNING id;`,
      [productId],
    );
    expect(inserted).toHaveLength(1);

    // Verify invalid placement throws check constraint violation
    await expect(
      client.query(
        `INSERT INTO catalog.product_options (product_id, name, display_type, card_placement, position)
         VALUES ($1, 'Invalid Placement', 'pill', 'invalid-slot', 100);`,
        [productId],
      ),
    ).rejects.toThrow(/product_options_card_placement_check/);
  });

  it('21. keeps processed_events idempotent on event_id', async () => {
    const { rows: columns } = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'catalog' AND table_name = 'processed_events'
       ORDER BY ordinal_position;`,
    );

    expect(columns).toEqual([
      {
        column_name: 'event_id',
        data_type: 'character varying',
        is_nullable: 'NO',
      },
      { column_name: 'topic', data_type: 'character varying', is_nullable: 'NO' },
      {
        column_name: 'processed_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
    ]);

    const eventId = `evt-${randomUUID()}`;
    const insert = `INSERT INTO catalog.processed_events (event_id, topic)
                    VALUES ($1, 'order.created')
                    ON CONFLICT (event_id) DO NOTHING
                    RETURNING event_id`;

    const first = await client.query(insert, [eventId]);
    expect(first.rowCount).toBe(1);

    // The claim is the consumer's idempotency gate: a replay claims nothing.
    const replay = await client.query(insert, [eventId]);
    expect(replay.rowCount).toBe(0);

    // The event id is the identity — two topics cannot both own one id.
    await client.query('SAVEPOINT processed_sp');
    await expect(
      client.query(
        `INSERT INTO catalog.processed_events (event_id, topic) VALUES ($1, 'order.status.updated')`,
        [eventId],
      ),
    ).rejects.toThrow(/processed_events_pkey/);
    await client.query('ROLLBACK TO SAVEPOINT processed_sp');
  });
});

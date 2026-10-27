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

  it('1. all 13 base tables exist in catalog schema', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name 
       FROM information_schema.tables 
       WHERE table_schema = 'catalog' AND table_type = 'BASE TABLE'
       ORDER BY table_name;`,
    );

    const tableNames = rows.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'brands',
      'categories',
      'product_attribute_values',
      'product_attributes',
      'product_discounts',
      'product_images',
      'product_option_values',
      'product_options',
      'product_variant_option_values',
      'product_variants',
      'products',
      'reviews',
      'stock_movements',
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
      'idx_product_discounts_active',
      'idx_discounts_active_range',
      'idx_reviews_product_approved',
      'idx_reviews_user_id',
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
    ).rejects.toThrow(/violates check constraint "product_discounts_type_check"/);

    await client.query('ROLLBACK TO SAVEPOINT test_sp');
    await client.query('SAVEPOINT test_sp');

    // Percent > 100 should fail
    await expect(
      client.query(`
        INSERT INTO catalog.product_discounts (product_id, discount_type, value, starts_at, ends_at)
        VALUES ('${productId}', 'percent', 105, now(), now() + interval '1 day')
      `),
    ).rejects.toThrow(/violates check constraint "product_discounts_value_check"/);
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
    ).rejects.toThrow(/violates check constraint "stock_movements_reason_check"/);
  });

  it('12. verifies updated_at trigger updates timestamp on modified product', async () => {
    const { rows: prodRows } = await client.query<{ id: string; updated_at: string }>(
      `SELECT id, updated_at FROM catalog.products LIMIT 1;`,
    );
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
    expect(rows[0].indexdef).toContain("WHERE ((status)::text = 'active'::text)");
  });
});

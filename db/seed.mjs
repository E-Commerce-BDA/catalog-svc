#!/usr/bin/env node
/**
 * Applies `002-seed-catalog.sql` — the demo catalogue a development box needs in
 * order to click through the storefront.
 *
 * It is guarded twice, on purpose:
 *   * here, so the script itself refuses before it opens a connection;
 *   * in `src/config/fixture-seed.guard.ts`, so a *service* that is configured
 *     with the flag in production fails at boot instead of quietly serving demo
 *     data. A script is easy to run with an environment of its choosing; the
 *     process that serves traffic is not.
 *
 * Production data arrives through the admin CRUD routes and through
 * `product.imported` — never through this file.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = join(HERE, '002-seed-catalog.sql');

/** Every table the seed writes, in dependency order, for the report below. */
const COUNTED_TABLES = [
  'catalog.categories',
  'catalog.brands',
  'catalog.products',
  'catalog.product_images',
  'catalog.product_options',
  'catalog.product_option_values',
  'catalog.product_variants',
  'catalog.product_variant_option_values',
  'catalog.stock_movements',
];

function refuse(reason) {
  console.error(`catalog fixture seed refused: ${reason}`);
  process.exit(1);
}

// Same lookup order as the service: an exported variable wins, `.env` fills in.
if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // No `.env`; the DATABASE_URL check below reports it.
  }
}

if (process.env.NODE_ENV === 'production') {
  refuse('NODE_ENV is production, and this writes demo products');
}
if (process.env.CATALOG_ALLOW_FIXTURE_SEED !== 'true') {
  refuse('CATALOG_ALLOW_FIXTURE_SEED is not "true"');
}
if (!process.env.DATABASE_URL) {
  refuse('DATABASE_URL is not set');
}

const sql = await readFile(SEED_FILE, 'utf8');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
try {
  // The file is idempotent (`ON CONFLICT DO NOTHING` on every insert), so this
  // is safe to re-run and the counts below describe what is now in the tables.
  await client.query(sql);

  for (const table of COUNTED_TABLES) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS count FROM ${table}`,
    );
    console.log(`${table.padEnd(44)} ${rows[0].count}`);
  }

  console.log(
    '\nFixture seed applied. Production data comes from admin CRUD and product.imported.',
  );
} finally {
  await client.end();
}

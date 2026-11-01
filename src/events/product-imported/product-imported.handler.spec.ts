import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductImportedHandler } from './product-imported.handler.js';
import { ProductImportRejectedError } from './import.errors.js';
import type { ProductImportRepository } from './product-import.repository.js';

/**
 * The claim/upsert ordering, without a database.
 *
 * `withTransaction` is replaced by a synchronous-scoped stand-in that hands the
 * handler one fake client and records the claim SQL, so these cases can assert
 * *when* the claim happens relative to the write — the property that makes a
 * redelivery safe. Everything the write itself decides (category resolution,
 * variant upsert, the stock clamp, the image set) is SQL and is proved against
 * Postgres in `test/product-imported.e2e-spec.ts` instead; asserting SQL strings
 * against a mock would only restate the query.
 */
const harness = vi.hoisted(() => ({
  claimed: true,
  queries: [] as { sql: string; params: unknown[] }[],
  txCount: 0,
}));

vi.mock('../../db/tx.js', () => ({
  withTransaction: async (action: (client: unknown) => Promise<unknown>) => {
    harness.txCount += 1;
    return action({
      query: async (sql: string, params: unknown[] = []) => {
        harness.queries.push({ sql, params });
        if (sql.includes('processed_events')) {
          return { rows: harness.claimed ? [{ event_id: 'claimed' }] : [] };
        }
        return { rows: [] };
      },
    });
  },
}));

const EVENT_ID = '0190a8b0-0000-7000-8000-00000000f001';
const PRODUCT_ID = '0190a8b0-0000-7000-8000-00000000f002';

const payload = (overrides: Record<string, unknown> = {}) => ({
  productId: PRODUCT_ID,
  sku: 'IMP-100',
  name: 'Imported Widget',
  slug: 'imported-widget',
  price: 19.99,
  stock: 7,
  status: 'active',
  updatedAt: '2026-10-30T10:00:00.000Z',
  ...overrides,
});

const envelope = (overrides: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  type: 'product.imported',
  producer: 'import-svc',
  timestamp: '2026-10-30T10:00:01.000Z',
  payload: payload(),
  ...overrides,
});

describe('ProductImportedHandler', () => {
  let upsert: ReturnType<typeof vi.fn>;
  let handler: ProductImportedHandler;

  const writeResult = {
    productId: PRODUCT_ID,
    created: true,
    variants: 0,
    images: 0,
    stockFigures: 1,
  };

  const claimQueries = (): { sql: string; params: unknown[] }[] =>
    harness.queries.filter((query) => query.sql.includes('processed_events'));

  beforeEach(() => {
    harness.claimed = true;
    harness.queries = [];
    harness.txCount = 0;
    upsert = vi.fn().mockResolvedValue(writeResult);
    handler = new ProductImportedHandler({
      upsert,
    } as unknown as ProductImportRepository);
  });

  it('claims the event, applies the import, and reports what it wrote', async () => {
    const outcome = await handler.handle(envelope());

    expect(outcome).toEqual({ kind: 'applied', ...writeResult });
    expect(claimQueries()).toHaveLength(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[1]).toEqual(payload());
  });

  it('claims with the envelope id and the topic, not with the product id', async () => {
    await handler.handle(envelope());

    const [claim] = claimQueries();
    expect(claim.sql).toContain('ON CONFLICT (event_id) DO NOTHING');
    expect(claim.params).toEqual([EVENT_ID, 'product.imported']);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('short-circuits a replayed event id without writing anything', async () => {
    harness.claimed = false;

    const outcome = await handler.handle(envelope());

    expect(outcome).toEqual({ kind: 'duplicate', eventId: EVENT_ID });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('opens no transaction for an unreadable envelope', async () => {
    const outcome = await handler.handle({ id: 'x' });

    expect(outcome).toMatchObject({ kind: 'invalid', stage: 'envelope' });
    expect(harness.txCount).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('opens no transaction for a payload the contract rejects', async () => {
    const outcome = await handler.handle(
      envelope({ payload: payload({ sku: undefined }) }),
    );

    expect(outcome).toMatchObject({ kind: 'invalid', stage: 'payload' });
    expect(harness.txCount).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a price that is not a number before touching the database', async () => {
    const outcome = await handler.handle(
      envelope({ payload: payload({ price: 'nineteen ninety nine' }) }),
    );

    expect(outcome).toMatchObject({ kind: 'invalid', stage: 'payload' });
    expect(outcome).toHaveProperty('error', expect.stringContaining('price'));
    expect(harness.txCount).toBe(0);
  });

  it('refuses a variant price that is not a number', async () => {
    const outcome = await handler.handle(
      envelope({
        payload: payload({
          variants: [{ sku: 'IMP-100-RED', price: 'free' }],
        }),
      }),
    );

    expect(outcome).toMatchObject({ kind: 'invalid', stage: 'payload' });
    expect(outcome).toHaveProperty(
      'error',
      expect.stringContaining('IMP-100-RED'),
    );
    expect(harness.txCount).toBe(0);
  });

  it('normalises money strings to numbers before the write', async () => {
    await handler.handle(
      envelope({
        payload: payload({
          price: '19.99',
          variants: [{ sku: 'IMP-100-RED', price: '21.50' }],
        }),
      }),
    );

    const written = upsert.mock.calls[0]?.[1] as {
      price: unknown;
      variants: { price: unknown }[];
    };
    expect(written.price).toBe(19.99);
    expect(written.variants[0].price).toBe(21.5);
  });

  it('ignores a well-formed event that is not a product import', async () => {
    const outcome = await handler.handle(
      envelope({ type: 'order.created', payload: payload() }),
    );

    expect(outcome).toEqual({
      kind: 'ignored',
      reason: 'not-subscribed',
      type: 'order.created',
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('lets a rejection escape, so the claim rolls back with the write', async () => {
    upsert.mockRejectedValue(
      new ProductImportRejectedError('sku-conflict', 'sku taken'),
    );

    await expect(handler.handle(envelope())).rejects.toBeInstanceOf(
      ProductImportRejectedError,
    );

    // The exception is what makes the transport dead-letter the record instead of
    // committing an event whose side effect never happened.
    expect(claimQueries()).toHaveLength(1);
  });
});

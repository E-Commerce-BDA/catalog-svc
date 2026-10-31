import type { Pool, PoolClient } from 'pg';
import { getPool } from './pool.js';

/**
 * The shared pool or the transaction's client — both expose only `query` for
 * the purposes of a repository method.
 *
 * Widening to `Pick<Pool, 'query'>` rather than to `@ecom/messaging`'s
 * `Queryable` is deliberate: the port erases row types on purpose, and these
 * repositories still want `query<RawRow>()` inference. A `PoolClient` is
 * assignable to this, so a transaction client drops straight in.
 */
export type QueryHandle = Pick<Pool, 'query'>;

/**
 * Run `action` inside one Postgres transaction.
 *
 * Catalog had no transaction helper before cat-007: every repository method
 * grabbed its own pooled client, so two writes in one service method could
 * commit independently. The outbox needs the opposite — the domain row and the
 * event row must commit together — so the service opens one client here and
 * hands it to the repository and to `CatalogOutbox`.
 *
 * Same shape as cart-svc's private helper, promoted to a shared function
 * because three services (products, categories, badges) now need it.
 */
export async function withTransaction<T>(
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

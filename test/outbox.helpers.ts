import type { EventEnvelope } from '@ecom/contracts';
import type { Pool } from 'pg';

/**
 * A `catalog.outbox` row as the e2e suites read it.
 *
 * Every helper is scoped by `aggregate_id`: vitest runs spec files against one
 * shared `ecom` database, so a global `count(*)` is not stable while other
 * suites are creating products of their own.
 */
export interface CatalogOutboxRow {
  id: string;
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  envelope: EventEnvelope;
  status: string;
  attempts: number;
  last_error: string | null;
  locked_until: Date | null;
  created_at: Date;
  published_at: Date | null;
}

const OUTBOX_COLUMNS = `id, event_id, aggregate_type, aggregate_id, event_type,
       envelope, status, attempts, last_error, locked_until, created_at,
       published_at`;

/** All rows written for one aggregate, in publish order. */
export async function catalogOutboxRows(
  pool: Pool,
  aggregateIds: string[],
): Promise<CatalogOutboxRow[]> {
  if (aggregateIds.length === 0) {
    return [];
  }

  const { rows } = await pool.query<CatalogOutboxRow>(
    `SELECT ${OUTBOX_COLUMNS}
       FROM catalog.outbox
      WHERE aggregate_id = ANY($1::uuid[])
      ORDER BY created_at, id`,
    [aggregateIds],
  );

  return rows;
}

/** Teardown: the aggregate rows go, so their events go too. */
export async function deleteCatalogOutbox(
  pool: Pool,
  aggregateIds: string[],
): Promise<void> {
  if (aggregateIds.length === 0) {
    return;
  }

  await pool.query(
    `DELETE FROM catalog.outbox WHERE aggregate_id = ANY($1::uuid[])`,
    [aggregateIds],
  );
}

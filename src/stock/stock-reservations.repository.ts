import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import {
  ReservationClosedError,
  ReservationMismatchError,
} from './stock-reservations.errors.js';
import {
  isTerminal,
  type ExpiredReservation,
  type ReleasedItemResult,
  type ReservedItemResult,
  type ReservationStatus,
  type StockCommitOutcome,
  type StockCommitResult,
  type StockReleaseResult,
  type StockReservationItem,
  type StockReservationResult,
  type StockReservationView,
} from './stock.types.js';

interface ReservationRow {
  id: string;
  order_id: string | null;
  status: ReservationStatus;
  items: ReservedItemResult[] | null;
  expires_at: Date;
  created_at: Date;
}

interface DueReservationRow {
  id: string;
  order_id: string | null;
  items: ReservedItemResult[] | null;
}

interface StockRow {
  stock: number;
}

const RESERVATION_COLUMNS =
  'id, order_id, status, items, expires_at, created_at';

@Injectable()
export class StockReservationsRepository {
  private readonly logger = new Logger(StockReservationsRepository.name);

  private get pool(): Pool {
    return getPool();
  }

  /**
   * Takes a hold on stock. The caller-supplied id is the primary key, so a
   * replay returns the stored reservation instead of decrementing twice.
   */
  async reserve(
    reservationId: string,
    items: StockReservationItem[],
    ttlSeconds: number,
    orderId?: string,
  ): Promise<{ result: StockReservationResult; replayed: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Idempotency gate. A concurrent replay blocks on the primary-key index
      // entry until the first transaction commits, then matches the conflict
      // and claims nothing.
      const claimed = await client.query<{ id: string }>(
        `INSERT INTO catalog.stock_reservations (id, order_id, status, items, expires_at)
         VALUES ($1::uuid, $2::uuid, 'held', '[]'::jsonb, now() + make_interval(secs => $3))
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [reservationId, orderId ?? null, ttlSeconds],
      );

      let result: StockReservationResult;

      if (claimed.rows.length === 0) {
        const existing = await this.findForUpdate(client, reservationId);
        if (!existing) {
          throw new NotFoundException(
            `Reservation ${reservationId} disappeared while being claimed`,
          );
        }
        if (isTerminal(existing.status)) {
          throw new ConflictException({
            code: 'RESERVATION_CLOSED',
            message: `Reservation ${reservationId} is already ${existing.status}`,
          });
        }
        // Replay of a held/committed reservation: nothing was written, so the
        // rollback below is a no-op.
        result = this.toResult(existing);
      } else {
        const reservedItems: ReservedItemResult[] = [];
        for (const item of this.sortItems(items)) {
          reservedItems.push(
            await this.decrement(client, item, reservationId, orderId ?? null),
          );
        }

        const updated = await client.query<{ expires_at: Date }>(
          `UPDATE catalog.stock_reservations
              SET items = $2::jsonb, updated_at = now()
            WHERE id = $1
            RETURNING expires_at`,
          [reservationId, JSON.stringify(reservedItems)],
        );

        result = {
          reservationId,
          status: 'held',
          expiresAt: updated.rows[0].expires_at.toISOString(),
          items: reservedItems,
        };
      }

      await client.query('COMMIT');
      return { result, replayed: claimed.rows.length === 0 };
    } catch (err) {
      await client.query('ROLLBACK');
      throw this.mapPostgresError(err);
    } finally {
      client.release();
    }
  }

  /**
   * Restores the stored items once. Replaying a release (or releasing an
   * already expired hold) is a no-op, but a committed hold can no longer be
   * released — its stock was legitimately sold.
   */
  async release(reservationId: string): Promise<StockReleaseResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await this.findForUpdate(client, reservationId);
      if (!existing) {
        throw new NotFoundException(`Reservation ${reservationId} not found`);
      }
      if (existing.status === 'committed') {
        throw new ConflictException({
          code: 'RESERVATION_CLOSED',
          message: `Reservation ${reservationId} is already committed`,
        });
      }
      if (existing.status !== 'held') {
        await client.query('COMMIT');
        return { reservationId, status: existing.status, items: [] };
      }

      const releasedItems: ReleasedItemResult[] = [];
      for (const item of this.sortItems(existing.items ?? [])) {
        const restored = await this.restore(
          client,
          item,
          reservationId,
          existing.order_id,
        );
        if (restored) releasedItems.push(restored);
      }

      await client.query(
        `UPDATE catalog.stock_reservations
            SET status = 'released', updated_at = now()
          WHERE id = $1`,
        [reservationId],
      );
      await client.query('COMMIT');

      return { reservationId, status: 'released', items: releasedItems };
    } catch (err) {
      await client.query('ROLLBACK');
      throw this.mapPostgresError(err);
    } finally {
      client.release();
    }
  }

  /**
   * Runs `fn` on one pooled connection inside a single transaction. Every
   * caller of `commitInTransaction` (the HTTP route, the `order.created`
   * handler) needs the side effect and its `processed_events` claim to land or
   * vanish together, so the transaction boundary belongs here, not in each.
   *
   * The caller's error is rethrown unchanged: a ROLLBACK that itself fails
   * (lost connection) must not mask the reason the work was abandoned.
   */
  async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Connection is gone; the original error is the useful one.
      }
      throw this.mapPostgresError(err);
    } finally {
      client.release();
    }
  }

  /**
   * Claims an event id inside the caller's transaction. `false` means it was
   * already applied, so the side effect must be skipped.
   *
   * The row and the side effect commit together, so a rolled-back transaction
   * leaves no row behind and the redelivery retries the work.
   */
  async markProcessed(
    client: PoolClient,
    eventId: string,
    topic: string,
  ): Promise<boolean> {
    const res = await client.query<{ event_id: string }>(
      `INSERT INTO catalog.processed_events (event_id, topic)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, topic],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Consumes a held reservation inside a caller-owned transaction.
   *
   * No stock write and no movement row: stock was already decremented (with a
   * `sale` movement) when the hold was taken, so committing only records who
   * bought it. Re-committing for the same order is idempotent; every other
   * terminal state throws so the caller can roll back and dead-letter.
   */
  async commitInTransaction(
    client: PoolClient,
    reservationId: string,
    orderId?: string,
  ): Promise<StockCommitOutcome> {
    const requestedOrderId = orderId ?? null;

    const updated = await client.query<ReservationRow>(
      `UPDATE catalog.stock_reservations
          SET status = 'committed',
              order_id = COALESCE($2::uuid, order_id),
              updated_at = now()
        WHERE id = $1 AND status = 'held'
        RETURNING ${RESERVATION_COLUMNS}`,
      [reservationId, requestedOrderId],
    );

    const row = updated.rows[0];
    if (row) {
      return {
        outcome: 'committed',
        reservationId: row.id,
        orderId: row.order_id,
      };
    }

    const existing = await this.findForUpdate(client, reservationId);
    if (!existing) {
      // Retryable: the hold may still be uncommitted in another transaction.
      throw new NotFoundException(`Reservation ${reservationId} not found`);
    }
    if (existing.status === 'committed') {
      // A request without an order id cannot prove a mismatch, so it stays
      // idempotent; an event always carries one, and that one is checked.
      if (
        existing.order_id &&
        requestedOrderId &&
        existing.order_id !== requestedOrderId
      ) {
        throw new ReservationMismatchError(
          reservationId,
          existing.order_id,
          requestedOrderId,
        );
      }
      return {
        outcome: 'already-committed',
        reservationId,
        orderId: existing.order_id,
      };
    }
    throw new ReservationClosedError(reservationId, existing.status);
  }

  /** Consumes a held reservation; stock was already decremented at hold time. */
  async commit(
    reservationId: string,
    orderId?: string,
  ): Promise<StockCommitResult> {
    const { orderId: committedOrderId } = await this.withTransaction(
      (client) => this.commitInTransaction(client, reservationId, orderId),
    );

    return {
      reservationId,
      status: 'committed',
      orderId: committedOrderId,
    };
  }

  async getById(reservationId: string): Promise<StockReservationView | null> {
    const res = await this.pool.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS}
         FROM catalog.stock_reservations
        WHERE id = $1`,
      [reservationId],
    );
    const row = res.rows[0];
    if (!row) return null;

    return {
      ...this.toResult(row),
      orderId: row.order_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  /**
   * Releases holds past their expiry. `SKIP LOCKED` keeps concurrent sweeps
   * from fighting over the same rows.
   */
  async expireDue(limit: number): Promise<ExpiredReservation[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const due = await client.query<DueReservationRow>(
        `SELECT id, order_id, items
           FROM catalog.stock_reservations
          WHERE status = 'held' AND expires_at <= now()
          ORDER BY expires_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );

      const expired: ExpiredReservation[] = [];
      for (const row of due.rows) {
        const releasedItems: ReleasedItemResult[] = [];
        for (const item of this.sortItems(row.items ?? [])) {
          const restored = await this.restore(
            client,
            item,
            row.id,
            row.order_id,
          );
          if (restored) releasedItems.push(restored);
        }
        await client.query(
          `UPDATE catalog.stock_reservations
              SET status = 'expired', updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        expired.push({ reservationId: row.id, releasedItems });
      }

      await client.query('COMMIT');
      return expired;
    } catch (err) {
      await client.query('ROLLBACK');
      throw this.mapPostgresError(err);
    } finally {
      client.release();
    }
  }

  private async findForUpdate(
    client: PoolClient,
    reservationId: string,
  ): Promise<ReservationRow | null> {
    const res = await client.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS}
         FROM catalog.stock_reservations
        WHERE id = $1
        FOR UPDATE`,
      [reservationId],
    );
    return res.rows[0] ?? null;
  }

  private async decrement(
    client: PoolClient,
    item: StockReservationItem,
    reservationId: string,
    orderId: string | null,
  ): Promise<ReservedItemResult> {
    const currentStock = await this.lockStockRow(client, item);
    if (currentStock === null) {
      throw new NotFoundException(
        item.variantId
          ? `Variant ${item.variantId} on product ${item.productId} not found`
          : `Product ${item.productId} not found`,
      );
    }

    if (currentStock < item.quantity) {
      throw new ConflictException({
        code: 'INSUFFICIENT_STOCK',
        message: `Insufficient stock for product ${item.productId}${
          item.variantId ? ` (variant ${item.variantId})` : ''
        }. Available: ${currentStock}, requested: ${item.quantity}`,
      });
    }

    const remainingStock = currentStock - item.quantity;
    await this.writeStock(client, item, remainingStock);
    await this.recordMovement(
      client,
      item,
      -item.quantity,
      'sale',
      remainingStock,
      orderId,
      reservationId,
    );

    return {
      productId: item.productId,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
      remainingStock,
    };
  }

  private async restore(
    client: PoolClient,
    item: StockReservationItem,
    reservationId: string,
    orderId: string | null,
  ): Promise<ReleasedItemResult | null> {
    // Soft-deleted products still get their stock back; a hard-deleted row is
    // unrecoverable, so the reservation closes without a movement instead of
    // wedging the release.
    const currentStock = await this.lockStockRow(client, item, true);
    if (currentStock === null) {
      this.logger.warn(
        `Cannot restore stock for reservation ${reservationId}: product ${item.productId}${
          item.variantId ? ` variant ${item.variantId}` : ''
        } no longer exists`,
      );
      return null;
    }

    const restoredStock = currentStock + item.quantity;
    await this.writeStock(client, item, restoredStock);
    await this.recordMovement(
      client,
      item,
      item.quantity,
      'cancel',
      restoredStock,
      orderId,
      reservationId,
    );

    return {
      productId: item.productId,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
      restoredStock,
    };
  }

  private async lockStockRow(
    client: PoolClient,
    item: StockReservationItem,
    includeSoftDeletedProducts = false,
  ): Promise<number | null> {
    if (item.variantId) {
      const res = await client.query<StockRow>(
        `SELECT stock FROM catalog.product_variants
          WHERE id = $1 AND product_id = $2
          FOR UPDATE`,
        [item.variantId, item.productId],
      );
      return res.rows[0]?.stock ?? null;
    }

    const res = await client.query<StockRow>(
      includeSoftDeletedProducts
        ? `SELECT stock FROM catalog.products WHERE id = $1 FOR UPDATE`
        : `SELECT stock FROM catalog.products
            WHERE id = $1 AND deleted_at IS NULL
            FOR UPDATE`,
      [item.productId],
    );
    return res.rows[0]?.stock ?? null;
  }

  private async writeStock(
    client: PoolClient,
    item: StockReservationItem,
    stock: number,
  ): Promise<void> {
    if (item.variantId) {
      await client.query(
        `UPDATE catalog.product_variants
            SET stock = $1, updated_at = now()
          WHERE id = $2`,
        [stock, item.variantId],
      );
      return;
    }

    await client.query(
      `UPDATE catalog.products
          SET stock = $1, updated_at = now()
        WHERE id = $2`,
      [stock, item.productId],
    );
  }

  private async recordMovement(
    client: PoolClient,
    item: StockReservationItem,
    qtyChange: number,
    reason: 'sale' | 'cancel',
    qtyAfter: number,
    orderId: string | null,
    reservationId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO catalog.stock_movements (
         product_id, variant_id, qty_change, reason, order_id, qty_after, reservation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        item.productId,
        item.variantId ?? null,
        qtyChange,
        reason,
        orderId,
        qtyAfter,
        reservationId,
      ],
    );
  }

  /**
   * Deterministic lock order across concurrent reservations. Without this two
   * checkouts holding the same two products lock them in opposite orders.
   */
  private sortItems<T extends StockReservationItem>(items: T[]): T[] {
    return [...items].sort((a, b) => {
      const byProduct = a.productId.localeCompare(b.productId);
      if (byProduct !== 0) return byProduct;
      return (a.variantId ?? '').localeCompare(b.variantId ?? '');
    });
  }

  private toResult(row: ReservationRow): StockReservationResult {
    return {
      reservationId: row.id,
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
      items: row.items ?? [],
    };
  }

  private mapPostgresError(err: unknown): unknown {
    const pgErr = err as { code?: string; constraint?: string };
    if (
      pgErr?.code === '23505' &&
      pgErr.constraint === 'idx_stock_reservations_order'
    ) {
      return new ConflictException({
        code: 'RESERVATION_CONFLICT',
        message: 'This order already has a stock reservation',
      });
    }
    return err;
  }
}

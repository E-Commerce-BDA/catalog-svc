/**
 * Stock reservation lifecycle types.
 *
 * A reservation is a hold on stock created by order-svc during checkout. Stock
 * is decremented when the hold is taken (`held`) and restored exactly once when
 * the hold is released or expires; `committed` consumes the hold without moving
 * stock again. A `committed` hold whose order is then refunded is restocked once
 * more and becomes `refunded` — a distinct terminal state, because the units came
 * back after a sale rather than never having sold. Terminal states are never
 * re-entered.
 */
export type ReservationStatus =
  | 'held'
  | 'committed'
  | 'released'
  | 'expired'
  | 'refunded';

export interface StockReservationItem {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export interface ReservedItemResult {
  productId: string;
  variantId: string | null;
  quantity: number;
  remainingStock: number;
}

export interface ReleasedItemResult {
  productId: string;
  variantId: string | null;
  quantity: number;
  restoredStock: number;
}

export interface StockReservationResult {
  reservationId: string;
  status: ReservationStatus;
  expiresAt: string;
  items: ReservedItemResult[];
}

export interface StockReleaseResult {
  reservationId: string;
  status: ReservationStatus;
  items: ReleasedItemResult[];
}

export interface StockCommitResult {
  reservationId: string;
  status: ReservationStatus;
  orderId: string | null;
}

/**
 * Result of consuming a hold inside a caller-owned transaction. `outcome`
 * separates "this call moved the hold" from "it was already committed to the
 * same order", which the HTTP route ignores and the consumer reports as a
 * duplicate.
 */
export interface StockCommitOutcome {
  outcome: 'committed' | 'already-committed';
  reservationId: string;
  orderId: string | null;
}

export interface StockReservationView extends StockReservationResult {
  orderId: string | null;
  createdAt: string;
}

/**
 * What releasing a hold inside a caller-owned transaction turned out to be.
 *
 * `release()` keeps throwing for the two answers the HTTP route must report as
 * status codes (missing, committed). The consumer cannot throw: a committed hold
 * belonging to a cancelled order is a data anomaly worth a log line, not a dead
 * letter, and "the hold expired on its own" is a correct outcome, not a failure.
 * So the transaction body reports, and each caller maps.
 */
export type ReleaseOutcome =
  | { kind: 'released'; reservationId: string; items: ReleasedItemResult[] }
  /** The stock was already back on the shelf; nothing moved. */
  | {
      kind: 'already-released';
      reservationId: string;
      status: 'released' | 'expired' | 'refunded';
    }
  /** The stock was sold. Releasing would restock an item that has shipped. */
  | { kind: 'not-releasable'; reservationId: string; status: 'committed' };

/**
 * What restocking a committed hold inside a caller-owned transaction turned out
 * to be (cat-012).
 *
 * The refund path is the mirror of the release path but is entered only for a
 * `committed` hold, whose stock was already sold: the units come back with a
 * dedicated `return` movement and the hold lands on `refunded`, never `released`.
 * `already-restocked` is a redelivery of the same refund — the status guard makes
 * it a no-op rather than a second restock. `not-refundable` is the anomaly the
 * release path also refuses: a hold that is `held` (never sold), or already
 * `released`/`expired`, has nothing to restock after a sale.
 */
export type RestockOutcome =
  | { kind: 'restocked'; reservationId: string; items: ReleasedItemResult[] }
  /** The refund was already restocked; nothing moved. */
  | { kind: 'already-restocked'; reservationId: string }
  /** This hold has no sold stock to bring back. */
  | {
      kind: 'not-refundable';
      reservationId: string;
      status: 'held' | 'released' | 'expired';
    };

export interface ExpiredReservation {
  reservationId: string;
  releasedItems: ReleasedItemResult[];
}

/**
 * Released, expired, or refunded holds cannot be revived: the stock they
 * referenced has already been sold to someone else (or, for a refund, sold and
 * then brought back), so the hold has served its whole life.
 */
export function isTerminal(status: ReservationStatus): boolean {
  return status === 'released' || status === 'expired' || status === 'refunded';
}

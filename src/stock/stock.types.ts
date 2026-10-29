/**
 * Stock reservation lifecycle types.
 *
 * A reservation is a hold on stock created by order-svc during checkout. Stock
 * is decremented when the hold is taken (`held`) and restored exactly once when
 * the hold is released or expires; `committed` consumes the hold without moving
 * stock again. Terminal states are never re-entered.
 */
export type ReservationStatus = 'held' | 'committed' | 'released' | 'expired';

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

export interface StockReservationView extends StockReservationResult {
  orderId: string | null;
  createdAt: string;
}

export interface ExpiredReservation {
  reservationId: string;
  releasedItems: ReleasedItemResult[];
}

/**
 * Released or expired holds cannot be revived: the stock they referenced has
 * already been sold to someone else.
 */
export function isTerminal(status: ReservationStatus): boolean {
  return status === 'released' || status === 'expired';
}

import { ConflictException } from '@nestjs/common';

/**
 * The hold was released or expired, so its stock is already back on the shelf
 * and can no longer be sold to this order. Terminal: replaying the event
 * cannot repair it, which is why the consumer dead-letters instead of retrying.
 *
 * Extends `ConflictException` so the existing `POST /internal/stock/commit`
 * keeps answering 409 `RESERVATION_CLOSED` with no extra mapping.
 */
export class ReservationClosedError extends ConflictException {
  constructor(
    readonly reservationId: string,
    readonly reservationStatus: string,
  ) {
    super({
      code: 'RESERVATION_CLOSED',
      message: `Reservation ${reservationId} is already ${reservationStatus}`,
    });
  }
}

/**
 * The hold is committed to a different order than the one asking for it: the
 * two records disagree about who owns the stock. Terminal for the same reason —
 * committing would either double-spend or steal another order's reservation.
 */
export class ReservationMismatchError extends ConflictException {
  constructor(
    readonly reservationId: string,
    readonly storedOrderId: string,
    readonly requestedOrderId: string,
  ) {
    super({
      code: 'RESERVATION_MISMATCH',
      message: `Reservation ${reservationId} belongs to order ${storedOrderId}, not ${requestedOrderId}`,
    });
  }
}

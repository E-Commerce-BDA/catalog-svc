import { Injectable, Logger } from '@nestjs/common';
import {
  parseEventPayload,
  readEventEnvelope,
  type OrderStatusUpdatedPayload,
} from '@ecom/contracts';
import { ZodError } from 'zod';
import { StockReservationsRepository } from '../../stock/stock-reservations.repository.js';

/** The second event this consumer interprets; `order.created` is the first. */
const ORDER_STATUS_UPDATED = 'order.status.updated';

/**
 * The three transitions that undo a sale.
 *
 * The forward moves — `confirmed`, `processing`, `shipped`, `delivered` — never
 * release: at `confirmed` the hold is being converted into a sale, and past that
 * the stock has left the building. `pending` is a saga that has not finished, so
 * releasing on it would fight the checkout that is still running.
 */
const RELEASE_STATUSES = new Set(['cancelled', 'failed', 'refunded']);

/** Longest error summary kept on a DLQ record; a Zod error can be huge. */
const MAX_ERROR_LENGTH = 300;
const MAX_ISSUES = 3;

/**
 * What one `order.status.updated` record turns out to be.
 *
 * `not-releasable` is an `ignored`, not a throw: a committed hold whose order was
 * then cancelled describes a stock anomaly (the item shipped), and a dead letter
 * would bury it under retry noise instead of putting one warning line in the log.
 */
export type OrderStatusUpdatedOutcome =
  | {
      kind: 'released';
      reservationId: string;
      orderId: string;
      eventId: string;
      /** Distinguishes "this event restored stock" from a redelivery. */
      outcome: 'released' | 'already-released';
    }
  | { kind: 'duplicate'; eventId: string }
  | {
      kind: 'ignored';
      reason:
        | 'not-subscribed'
        | 'not-release-status'
        | 'no-reservation'
        | 'not-releasable';
      type?: string;
      /** The status that made this a no-op, for the log line. */
      status?: string;
      orderId?: string;
    }
  | { kind: 'invalid'; stage: 'envelope' | 'payload'; error: string };

/**
 * Turns an `order.status.updated` into a released hold.
 *
 * This is the durable half of the release. order-svc still calls
 * `POST /internal/stock/release` when it cancels an order, but that call is
 * best-effort — a catalog that is down at that moment leaves the hold to expire
 * on its own TTL, and the customer's unit stays unsellable until it does. The
 * event carries the same intent through Kafka, which retries.
 *
 * The payload gives an order id and no reservation id, so the reservation is
 * found through `order_id`. Checkout sets that column while the hold is still
 * `held`, which is exactly the window this handler exists for.
 */
@Injectable()
export class OrderStatusUpdatedHandler {
  private readonly logger = new Logger(OrderStatusUpdatedHandler.name);

  constructor(private readonly reservations: StockReservationsRepository) {}

  async handle(raw: unknown): Promise<OrderStatusUpdatedOutcome> {
    let envelope: ReturnType<typeof readEventEnvelope>;
    try {
      envelope = readEventEnvelope(raw);
    } catch (error) {
      return { kind: 'invalid', stage: 'envelope', error: describe(error) };
    }

    const { type } = envelope;

    if (type !== ORDER_STATUS_UPDATED) {
      // Defensive: the consumer only subscribes to declared topics. An event we
      // have no use for is committed, never dead-lettered.
      return { kind: 'ignored', reason: 'not-subscribed', type };
    }

    let payload: OrderStatusUpdatedPayload;
    try {
      payload = parseEventPayload(ORDER_STATUS_UPDATED, envelope.payload);
    } catch (error) {
      return { kind: 'invalid', stage: 'payload', error: describe(error) };
    }

    if (!RELEASE_STATUSES.has(payload.to)) {
      // The common case: most status events are forward moves.
      return {
        kind: 'ignored',
        reason: 'not-release-status',
        status: payload.to,
      };
    }

    const eventId = envelope.id;

    return this.reservations.withTransaction(async (client) => {
      const claimed = await this.reservations.markProcessed(
        client,
        eventId,
        ORDER_STATUS_UPDATED,
      );
      if (!claimed) {
        return { kind: 'duplicate', eventId };
      }

      const reservation = await this.reservations.findByOrderIdForUpdate(
        client,
        payload.orderId,
      );
      if (!reservation) {
        // The hold expired before the cancellation arrived, or this order never
        // held stock (a resumed legacy order). Correct end state, not a failure.
        this.logger.warn(
          `Order ${payload.orderId} became ${payload.to} with no stock reservation; nothing to release`,
        );
        return { kind: 'ignored', reason: 'no-reservation' };
      }

      const released = await this.reservations.releaseInTransaction(
        client,
        reservation.id,
      );
      if (!released) {
        // Deleted between the two statements, which the row lock makes
        // impossible; treat it as the no-reservation answer rather than throw.
        return { kind: 'ignored', reason: 'no-reservation' };
      }
      if (released.kind === 'not-releasable') {
        return {
          kind: 'ignored',
          reason: 'not-releasable',
          status: released.status,
          orderId: payload.orderId,
        };
      }

      return {
        kind: 'released',
        reservationId: released.reservationId,
        orderId: payload.orderId,
        eventId,
        outcome: released.kind,
      };
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof ZodError) {
    const issues = error.issues
      .slice(0, MAX_ISSUES)
      .map((issue) => {
        const path = issue.path.map(String).join('.') || '<root>';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    const rest = error.issues.length - MAX_ISSUES;
    return clip(rest > 0 ? `${issues} (+${rest} more)` : issues);
  }

  return clip(error instanceof Error ? error.message : String(error));
}

function clip(text: string): string {
  return text.length > MAX_ERROR_LENGTH
    ? `${text.slice(0, MAX_ERROR_LENGTH)}…`
    : text;
}

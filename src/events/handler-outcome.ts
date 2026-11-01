import { Logger } from '@nestjs/common';
import type { KafkaHandlerOutcome } from '@ecom/messaging';
import type { OrderCreatedOutcome } from './order-created/order-created.handler.js';
import type { OrderStatusUpdatedOutcome } from './order-status-updated/order-status-updated.handler.js';
import type { ProductImportedOutcome } from './product-imported/product-imported.handler.js';

const orderLogger = new Logger('order.created');
const releaseLogger = new Logger('order.status.updated');

/**
 * Translates each handler's verdict into the shared consumer protocol's.
 *
 * The two shapes differ only in naming, and keeping them apart is deliberate:
 * `OrderCreatedHandler` and `ProductImportedHandler` are the business half and
 * should not have to know what a transport does with their answer, while
 * `KafkaEventHandler` should not have to know what a reservation or an import
 * is. This file is the single seam between them.
 *
 * `counter` is set on the order path because catalog's dashboard reads
 * `committed` — the name `cat-007`'s five-counter class used — and the protocol
 * defaults to `accepted`. The import path has no historical name of its own, so
 * it takes the default.
 */
export function toOrderCreatedOutcome(
  outcome: OrderCreatedOutcome,
): KafkaHandlerOutcome {
  switch (outcome.kind) {
    case 'committed':
      // Preserved from the hand-written consumer: an operator reading logs after
      // a checkout needs the reservation and the order on one line.
      if (outcome.outcome === 'already-committed') {
        orderLogger.debug(
          `Reservation ${outcome.reservationId} was already committed to order ${outcome.orderId}; event ${outcome.eventId} is a no-op`,
        );
      } else {
        orderLogger.log(
          `Committed reservation ${outcome.reservationId} for order ${outcome.orderId} (event ${outcome.eventId})`,
        );
      }
      return { kind: 'applied', counter: 'committed' };
    case 'duplicate':
      return { kind: 'duplicate', eventId: outcome.eventId };
    case 'ignored':
      return { kind: 'ignored', reason: outcome.reason, type: outcome.type };
    case 'invalid':
      return { kind: 'invalid', stage: outcome.stage, error: outcome.error };
  }
}

/**
 * The release path's verdict.
 *
 * `applied` carries no counter, unlike the order path: `AppliedCounter` is a
 * closed union in `@ecom/messaging` (`accepted` / `skipped` / `committed`) and
 * renaming a counter is a messaging release plus a repin for a dashboard label.
 * A release therefore counts as `accepted`, which is what it is — the record was
 * applied — and the log line below is what names the reservation and the order.
 */
export function toOrderStatusUpdatedOutcome(
  outcome: OrderStatusUpdatedOutcome,
): KafkaHandlerOutcome {
  switch (outcome.kind) {
    case 'released':
      if (outcome.outcome === 'already-released') {
        releaseLogger.debug(
          `Reservation ${outcome.reservationId} for order ${outcome.orderId} was already released; event ${outcome.eventId} is a no-op`,
        );
      } else {
        releaseLogger.log(
          `Released reservation ${outcome.reservationId} for order ${outcome.orderId} (event ${outcome.eventId})`,
        );
      }
      return { kind: 'applied' };
    case 'duplicate':
      return { kind: 'duplicate', eventId: outcome.eventId };
    case 'ignored':
      if (outcome.reason === 'not-releasable') {
        // Committed stock has been sold. Restocking it after a post-delivery
        // refund is a different decision with its own movement reason, so this
        // is one warning line, not a dead letter and not a silent no-op.
        releaseLogger.warn(
          `Order ${outcome.orderId} was cancelled but its reservation is ${outcome.status}: the stock was sold and is not restored (cat-012)`,
        );
      }
      return { kind: 'ignored', reason: outcome.reason, type: outcome.type };
    case 'invalid':
      return { kind: 'invalid', stage: outcome.stage, error: outcome.error };
  }
}

/**
 * The import path's verdict.
 *
 * `applied` carries no counter: there is no `cat-008` dashboard to keep, and
 * `accepted` is the protocol's default. The handler itself logs what it wrote,
 * because only it knows the counts.
 */
export function toProductImportedOutcome(
  outcome: ProductImportedOutcome,
): KafkaHandlerOutcome {
  switch (outcome.kind) {
    case 'applied':
      return { kind: 'applied' };
    case 'duplicate':
      return { kind: 'duplicate', eventId: outcome.eventId };
    case 'ignored':
      return { kind: 'ignored', reason: outcome.reason, type: outcome.type };
    case 'invalid':
      return { kind: 'invalid', stage: outcome.stage, error: outcome.error };
  }
}

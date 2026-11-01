import { Logger } from '@nestjs/common';
import type { KafkaHandlerOutcome } from '@ecom/messaging';
import type { OrderCreatedOutcome } from './order-created/order-created.handler.js';
import type { ProductImportedOutcome } from './product-imported/product-imported.handler.js';

const orderLogger = new Logger('order.created');

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

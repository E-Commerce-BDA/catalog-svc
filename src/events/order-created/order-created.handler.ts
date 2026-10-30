import { Injectable, Logger } from '@nestjs/common';
import {
  parseEventPayload,
  readEventEnvelope,
  type OrderCreatedPayload,
} from '@ecom/contracts';
import { ZodError } from 'zod';
import { StockReservationsRepository } from '../../stock/stock-reservations.repository.js';

/** The only event this handler interprets; `cat-010` adds `order.status.updated`. */
const ORDER_CREATED = 'order.created';

/** Longest error summary kept on a DLQ record; a Zod error can be huge. */
const MAX_ERROR_LENGTH = 300;
const MAX_ISSUES = 3;

/**
 * What one `order.created` record turns out to be. The four branches map
 * one-to-one onto what the consumer can do with it: commit the offset, or
 * dead-letter it.
 *
 * A closed / mismatched / missing reservation is *not* represented here: those
 * are thrown so the transaction rolls the `processed_events` claim back and the
 * consumer can classify them as terminal.
 */
export type OrderCreatedOutcome =
  | {
      kind: 'committed';
      reservationId: string;
      orderId: string;
      eventId: string;
      /** Distinguishes "this event moved the hold" from an idempotent replay. */
      outcome: 'committed' | 'already-committed';
    }
  | { kind: 'duplicate'; eventId: string }
  | {
      kind: 'ignored';
      reason: 'not-subscribed' | 'no-reservation';
      type?: string;
    }
  | { kind: 'invalid'; stage: 'envelope' | 'payload'; error: string };

/**
 * Turns `order.created` into a committed reservation.
 *
 * Pure classification first — envelope, then payload, then whether there is
 * anything to do at all — because a message we cannot understand must be
 * dead-lettered without opening a transaction. Only the last step touches the
 * database, and it does so in a single transaction so the event claim and the
 * commit land together.
 */
@Injectable()
export class OrderCreatedHandler {
  private readonly logger = new Logger(OrderCreatedHandler.name);

  constructor(private readonly reservations: StockReservationsRepository) {}

  async handle(raw: unknown): Promise<OrderCreatedOutcome> {
    let envelope: ReturnType<typeof readEventEnvelope>;
    try {
      // Normalizes the legacy `topic`/`eventType` dual-write against `type`.
      envelope = readEventEnvelope(raw);
    } catch (error) {
      return { kind: 'invalid', stage: 'envelope', error: describe(error) };
    }

    const { type } = envelope;

    if (type !== ORDER_CREATED) {
      // The consumer only subscribes to one topic, so this is defensive: an
      // event we have no use for is committed, never dead-lettered.
      return { kind: 'ignored', reason: 'not-subscribed', type };
    }

    let payload: OrderCreatedPayload;
    try {
      payload = parseEventPayload(ORDER_CREATED, envelope.payload);
    } catch (error) {
      return { kind: 'invalid', stage: 'payload', error: describe(error) };
    }

    if (payload.reservationId === '') {
      // Contract-allowed: a resumed legacy order that never held stock has
      // nothing to commit. Not a failure, so not a DLQ record either.
      this.logger.warn(
        `Order ${payload.orderId} has no stock reservation; nothing to commit`,
      );
      return { kind: 'ignored', reason: 'no-reservation' };
    }

    const eventId = envelope.id;
    const reservationId = payload.reservationId;

    return this.reservations.withTransaction(async (client) => {
      const claimed = await this.reservations.markProcessed(
        client,
        eventId,
        ORDER_CREATED,
      );
      if (!claimed) {
        return { kind: 'duplicate', eventId };
      }

      const committed = await this.reservations.commitInTransaction(
        client,
        reservationId,
        payload.orderId,
      );

      return {
        kind: 'committed',
        reservationId: committed.reservationId,
        orderId: committed.orderId ?? payload.orderId,
        eventId,
        outcome: committed.outcome,
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

import { Injectable, Logger } from '@nestjs/common';
import {
  parseEventPayload,
  readEventEnvelope,
  type ProductImportedPayload,
} from '@ecom/contracts';
import { ProcessedEventsStore } from '@ecom/messaging';
import { ZodError } from 'zod';
import { withTransaction } from '../../db/tx.js';
import type { ImportWriteResult } from './product-import.repository.js';
import { ProductImportRepository } from './product-import.repository.js';

/** The only event this handler interprets. */
const PRODUCT_IMPORTED = 'product.imported';

/** Longest error summary kept on a DLQ record; a Zod error can be huge. */
const MAX_ERROR_LENGTH = 300;
const MAX_ISSUES = 3;

/**
 * What one `product.imported` record turns out to be.
 *
 * There is no `ignored`-with-a-business-reason branch here, unlike
 * `order.created`: every import either applies, is a replay, or cannot be read.
 * A rejected import (a dangling category id, a sku owned by another product) is
 * *thrown*, not returned, so the transaction rolls the claim back and the record
 * lands in `product.imported.dlq` with a reason from `ProductImportReason`.
 */
export type ProductImportedOutcome =
  | ({ kind: 'applied' } & ImportWriteResult)
  | { kind: 'duplicate'; eventId: string }
  | { kind: 'ignored'; reason: string; type?: string }
  | { kind: 'invalid'; stage: 'envelope' | 'payload'; error: string };

/**
 * Turns one `product.imported` record into catalog rows.
 *
 * Classification first — envelope, then payload, then the money strings —
 * because a message we cannot read must be dead-lettered without opening a
 * transaction. The whole write then happens in one transaction with the
 * `processed_events` claim, which is the only thing that makes a redelivery
 * safe: a claim that commits without the rows, or rows without the claim, are
 * both worse than a duplicate delivery.
 *
 * **No outbox row is written** (`D2`). search-svc already consumes
 * `product.imported` itself, so a 10 000-row import would otherwise become
 * 10 000 extra `product.updated` events on the relay, all describing a change the
 * index is about to receive anyway. This is deliberate: do not "fix" it later by
 * adding an emit.
 */
@Injectable()
export class ProductImportedHandler {
  private readonly logger = new Logger(ProductImportedHandler.name);

  /**
   * The idempotency claim, shared with search-svc and cart-svc. `catalog`'s
   * table (`db/006`) already has the shape the store expects.
   */
  private readonly processed = new ProcessedEventsStore({ schema: 'catalog' });

  constructor(private readonly repository: ProductImportRepository) {}

  async handle(raw: unknown): Promise<ProductImportedOutcome> {
    let envelope: ReturnType<typeof readEventEnvelope>;
    try {
      envelope = readEventEnvelope(raw);
    } catch (error) {
      return { kind: 'invalid', stage: 'envelope', error: describe(error) };
    }

    if (envelope.type !== PRODUCT_IMPORTED) {
      // The topic is its own `@EventPattern`, so this is defensive: an event we
      // have no use for is committed, never dead-lettered.
      return { kind: 'ignored', reason: 'not-subscribed', type: envelope.type };
    }

    let payload: ProductImportedPayload;
    try {
      payload = parseEventPayload(PRODUCT_IMPORTED, envelope.payload);
    } catch (error) {
      return { kind: 'invalid', stage: 'payload', error: describe(error) };
    }

    // Money arrives as a string from some producers and a number from others;
    // a string that is not a number at all is an unreadable payload, and must be
    // dead-lettered now rather than retried into a 22P02 for 31 seconds.
    const money = withNumericPrice(payload);
    if ('error' in money) {
      return { kind: 'invalid', stage: 'payload', error: money.error };
    }

    const eventId = envelope.id;
    const result = await withTransaction(async (client) => {
      const claimed = await this.processed.claim(
        client,
        eventId,
        PRODUCT_IMPORTED,
      );
      if (!claimed) {
        return { kind: 'duplicate' as const, eventId };
      }

      return {
        kind: 'applied' as const,
        ...(await this.repository.upsert(client, money.payload)),
      };
    });

    if (result.kind === 'applied') {
      this.logger.log(
        `Applied event ${eventId}: product ${result.productId} ${result.created ? 'created' : 'updated'} (${result.variants} variant(s), ${result.images} image(s), ${result.stockFigures} stock figure(s))`,
      );
    }

    return result;
  }
}

/**
 * Replaces the payload's prices with numbers, and refuses the payload when one
 * of them is not a number at all.
 *
 * `effectivePrice` is dropped on purpose: it is derived from
 * `catalog.product_discounts` everywhere else in this service
 * (`computeEffectivePrice`), and catalog's own `product.updated` emitter never
 * sends it either. An import that wanted a sale price would need a discount row,
 * which a `product.imported` payload cannot express.
 */
function withNumericPrice(
  payload: ProductImportedPayload,
): { payload: ProductImportedPayload } | { error: string } {
  const price = Number(payload.price);
  if (!Number.isFinite(price)) {
    return { error: `price: ${describeValue(payload.price)} is not a number` };
  }

  let error: string | null = null;
  const variants = payload.variants?.map((variant) => {
    const variantPrice = Number(variant.price);
    if (!Number.isFinite(variantPrice)) {
      error ??= `variants.${variant.sku}.price: ${describeValue(variant.price)} is not a number`;
      return variant;
    }
    return { ...variant, price: variantPrice };
  });

  if (error) {
    return { error };
  }

  return { payload: { ...payload, price, variants } };
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
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

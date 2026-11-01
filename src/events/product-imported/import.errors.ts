/**
 * Why an import could not be applied.
 *
 * These four are the *only* reasons an import is rejected, and all four are
 * repairable by a human: a reference that does not exist, or a sku/slug already
 * held by a different product. That is what makes them dead letters rather than
 * retries — redelivering the same record cannot change the answer.
 *
 * The strings are the DLQ `reason` values, so they are part of the operational
 * surface, not an internal detail: `product.imported.dlq` is queryable by them.
 */
export type ProductImportReason =
  | 'unresolved-reference'
  | 'sku-conflict'
  | 'slug-conflict'
  | 'variant-sku-conflict';

/**
 * A deterministic rejection: the payload is well-formed, the database is
 * reachable, and the write still cannot be made.
 *
 * Thrown rather than returned because it must roll back the `processed_events`
 * claim, and an exception is the only thing that does that. The transport reads
 * `reason` through `translateError` and dead-letters immediately instead of
 * burning the 31-second retry ladder on an answer that will not change.
 */
export class ProductImportRejectedError extends Error {
  constructor(
    readonly reason: ProductImportReason,
    message: string,
  ) {
    super(message);
    this.name = 'ProductImportRejectedError';
  }
}

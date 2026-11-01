import type { EventTopic } from '@ecom/contracts';

/**
 * The topics catalog-svc consumes.
 *
 * One list feeds three things that must never disagree: the controller's
 * `@EventPattern` strings, the lag sampler's topic set, and the DLQ names (which
 * come from the registry for a registered topic). `cat-010` added
 * `order.status.updated` here plus one method on the controller — never a
 * second consumer, because two consumers in one group split the partitions
 * between them.
 */
export const CATALOG_CONSUMER_TOPICS = [
  'order.created',
  'product.imported',
  'order.status.updated',
] as const satisfies readonly EventTopic[];

export type CatalogTopic = (typeof CATALOG_CONSUMER_TOPICS)[number];

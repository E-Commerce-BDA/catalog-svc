import { Injectable } from '@nestjs/common';
import type { OrderCreatedOutcome } from './order-created/order-created.handler.js';

/**
 * Per-outcome counters for the consumer. Process-local and reset on boot, which
 * is the cheapest thing that can answer "how many events did we drop in the
 * last hour" without a metrics sidecar.
 *
 * `invalid` covers messages that can never be understood (envelope/payload
 * drift); an event that is well-formed but finds a closed reservation is
 * counted only as `dlq`, because the DLQ record carries the reason.
 */
export type ConsumerOutcome =
  | 'committed'
  | 'duplicate'
  | 'ignored'
  | 'invalid'
  | 'dlq';

export type ConsumerStatsSnapshot = Record<ConsumerOutcome, number>;

const OUTCOMES: readonly ConsumerOutcome[] = [
  'committed',
  'duplicate',
  'ignored',
  'invalid',
  'dlq',
];

@Injectable()
export class ConsumerMetrics {
  private readonly counts: ConsumerStatsSnapshot = {
    committed: 0,
    duplicate: 0,
    ignored: 0,
    invalid: 0,
    dlq: 0,
  };

  record(outcome: ConsumerOutcome): void {
    this.counts[outcome] += 1;
  }

  snapshot(): ConsumerStatsSnapshot {
    return { ...this.counts };
  }

  reset(): void {
    for (const outcome of OUTCOMES) {
      this.counts[outcome] = 0;
    }
  }
}

/**
 * Folds one handled outcome into the counters.
 *
 * `dlq` is deliberately *not* recorded here: it counts DLQ writes that actually
 * succeeded, and only the Kafka consumer can know that.
 */
export function recordOutcome(
  metrics: ConsumerMetrics,
  outcome: OrderCreatedOutcome,
): void {
  switch (outcome.kind) {
    case 'committed':
      metrics.record('committed');
      break;
    case 'duplicate':
      metrics.record('duplicate');
      break;
    case 'ignored':
      metrics.record('ignored');
      break;
    case 'invalid':
      metrics.record('invalid');
      break;
  }
}

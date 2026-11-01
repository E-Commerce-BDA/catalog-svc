import { Injectable } from '@nestjs/common';
import {
  ConsumerMetrics as SharedConsumerMetrics,
  type ConsumerCommitMark,
  type ConsumerCounters,
  type LagSample,
} from '@ecom/messaging';

/**
 * The counters themselves live in `@ecom/messaging`, so all three services
 * report the same nine names.
 *
 * What stays here is the Nest provider and the shape of the endpoint. Catalog
 * used to keep its own five-counter class (`committed`, `duplicate`, `ignored`,
 * `invalid`, `dlq`); those five are still reported, unchanged, and `accepted`,
 * `skipped`, `commit` and `stalled` are additive — which is why a dashboard
 * written against `cat-007` keeps working.
 *
 * Subclassing rather than aliasing keeps `ConsumerMetrics` injectable and keeps
 * every existing constructor signature (the e2e spec's `metrics.reset()`)
 * unchanged.
 */
@Injectable()
export class ConsumerMetrics extends SharedConsumerMetrics {}

/**
 * What `GET /api/v1/catalog/internal/consumer-stats` answers.
 *
 * Counters first, then the position and the lag next to each other: a lag
 * without a last commit cannot distinguish "behind" from "stopped", which is
 * the one question this endpoint exists to answer.
 */
export interface ConsumerStatsSnapshot extends ConsumerCounters {
  /** Uncommitted records per topic, from the last background sample. */
  lag: Record<string, number>;
  totalLag: number;
  lastCommit: ConsumerCommitMark | null;
  /** `null` until the first sample; the gauge is not the consumer's health. */
  sampledAt: string | null;
}

/** Composes the endpoint's payload from the counters and the last lag sample. */
export function buildConsumerStats(
  metrics: ConsumerMetrics,
  sample: LagSample | null,
): ConsumerStatsSnapshot {
  return {
    ...metrics.snapshot(),
    lag: sample?.lag ?? {},
    totalLag: sample?.totalLag ?? 0,
    lastCommit: metrics.lastCommit(),
    sampledAt: sample?.sampledAt ?? null,
  };
}

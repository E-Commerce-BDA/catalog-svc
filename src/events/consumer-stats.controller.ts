import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { KafkaLagSampler } from '@ecom/messaging';
import { ServiceKeyGuard } from '../auth/guards/service-key.guard.js';
import {
  buildConsumerStats,
  ConsumerMetrics,
  type ConsumerStatsSnapshot,
} from './consumer-metrics.js';

/**
 * Observability for the consumer: the counters are the only way to see how many
 * events were committed, deduped, ignored or dead-lettered without reading
 * logs. Same `catalog/internal` prefix and service key as the stock routes.
 *
 * Additive in `cat-008`: the same counters are reported and `lag`, `totalLag`,
 * `lastCommit` and `sampledAt` are new, so a dashboard written against the old
 * five-key body keeps working. The lag comes from a separate admin connection,
 * not from the consumer, so a broker the gauge cannot reach is a missing sample
 * rather than a stalled commit.
 */
@Controller('catalog/internal')
@UseGuards(ServiceKeyGuard)
export class ConsumerStatsController {
  constructor(
    private readonly metrics: ConsumerMetrics,
    private readonly lag: KafkaLagSampler,
  ) {}

  @Get('consumer-stats')
  @Header('Cache-Control', 'no-store')
  snapshot(): ConsumerStatsSnapshot {
    return buildConsumerStats(this.metrics, this.lag.latest());
  }
}

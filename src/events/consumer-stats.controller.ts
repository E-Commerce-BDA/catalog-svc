import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ServiceKeyGuard } from '../auth/guards/service-key.guard.js';
import {
  ConsumerMetrics,
  type ConsumerStatsSnapshot,
} from './consumer-metrics.js';

/**
 * Observability for the consumer: the counters are the only way to see how many
 * events were committed, deduped, ignored or dead-lettered without reading
 * logs. Same `catalog/internal` prefix and service key as the stock routes.
 */
@Controller('catalog/internal')
@UseGuards(ServiceKeyGuard)
export class ConsumerStatsController {
  constructor(private readonly metrics: ConsumerMetrics) {}

  @Get('consumer-stats')
  @Header('Cache-Control', 'no-store')
  snapshot(): ConsumerStatsSnapshot {
    return this.metrics.snapshot();
  }
}

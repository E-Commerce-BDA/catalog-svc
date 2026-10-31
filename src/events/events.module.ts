import { Global, Module } from '@nestjs/common';
import { StockModule } from '../stock/stock.module.js';
import { ConsumerMetrics } from './consumer-metrics.js';
import { ConsumerStatsController } from './consumer-stats.controller.js';
import { KafkaOrderConsumer } from './order-created/kafka-order-consumer.js';
import { OrderCreatedHandler } from './order-created/order-created.handler.js';

/**
 * The consume side of catalog-svc.
 *
 * Publishing moved to `CatalogOutbox` (cat-007): every outgoing event is a row
 * in `catalog.outbox` that the relay drains. What is left here only *reads*
 * from Kafka — `order.created` drives stock reservations — so there is no
 * producer path in this module any more.
 */
@Global()
@Module({
  // The handler owns the transaction, but the repository that runs it lives in
  // StockModule and is only reachable if that module is imported here.
  imports: [StockModule],
  controllers: [ConsumerStatsController],
  providers: [ConsumerMetrics, OrderCreatedHandler, KafkaOrderConsumer],
})
export class EventsModule {}

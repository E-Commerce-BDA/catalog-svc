import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaDlqPublisher, KafkaLagSampler } from '@ecom/messaging';
import { KafkaEventHandler } from '@ecom/messaging/nest';
import { StockModule } from '../stock/stock.module.js';
import {
  ReservationClosedError,
  ReservationMismatchError,
} from '../stock/stock-reservations.errors.js';
import { CATALOG_CONSUMER_TOPICS } from './catalog-topics.js';
import { CatalogConsumerController } from './catalog-consumer.controller.js';
import { ConsumerMetrics } from './consumer-metrics.js';
import {
  CONSUMER_GROUP_ID,
  ConsumerRuntime,
  NestRelayLogger,
  kafkaBrokers,
} from './consumer-runtime.js';
import { ConsumerStatsController } from './consumer-stats.controller.js';
import { OrderCreatedHandler } from './order-created/order-created.handler.js';
import { ProductImportRejectedError } from './product-imported/import.errors.js';
import { ProductImportRepository } from './product-imported/product-import.repository.js';
import { ProductImportedHandler } from './product-imported/product-imported.handler.js';

/**
 * The consume side of catalog-svc.
 *
 * Publishing moved to `CatalogOutbox` (`cat-007`): every outgoing event is a row
 * in `catalog.outbox` that the relay drains. What is left here only *reads* from
 * Kafka — `order.created` drives stock reservations, `product.imported` writes
 * the catalogue — so there is no producer path in this module.
 *
 * Every provider is constructed lazily by the package — no connection is opened
 * until the consumer actually starts or a record has to be dead-lettered — so
 * building this module in a test touches no broker.
 */
@Global()
@Module({
  // The order handler owns its transaction, but the repository that runs it
  // lives in StockModule and is only reachable if that module is imported here.
  imports: [StockModule],
  controllers: [ConsumerStatsController, CatalogConsumerController],
  providers: [
    ConsumerMetrics,
    ProductImportRepository,
    OrderCreatedHandler,
    ProductImportedHandler,
    {
      provide: KafkaDlqPublisher,
      useFactory: (config: ConfigService) =>
        new KafkaDlqPublisher({
          brokers: kafkaBrokers(config),
          clientId: `${CONSUMER_GROUP_ID}-dlq`,
        }),
      inject: [ConfigService],
    },
    {
      provide: KafkaEventHandler,
      useFactory: (dlq: KafkaDlqPublisher, metrics: ConsumerMetrics) =>
        new KafkaEventHandler({
          dlq,
          metrics,
          logger: new NestRelayLogger(new Logger('KafkaConsumer')),
          // Both of these are answers redelivery cannot change: a hold that is
          // closed or belongs to another order, and an import whose reference
          // or sku is already taken. Dead-lettered on the first attempt, so an
          // operator sees the reason immediately instead of 31 seconds later.
          translateError: dlqReason,
        }),
      inject: [KafkaDlqPublisher, ConsumerMetrics],
    },
    {
      provide: KafkaLagSampler,
      // The sampler is measured as the group itself, so the endpoint reports
      // the same lag `kafka-consumer-groups --describe` would.
      useFactory: (config: ConfigService) =>
        new KafkaLagSampler({
          brokers: kafkaBrokers(config),
          clientId: `${CONSUMER_GROUP_ID}-lag`,
          groupId: CONSUMER_GROUP_ID,
          topics: CATALOG_CONSUMER_TOPICS,
          logger: new NestRelayLogger(new Logger('ConsumerLag')),
        }),
      inject: [ConfigService],
    },
    ConsumerRuntime,
  ],
  exports: [ConsumerMetrics, KafkaEventHandler, KafkaLagSampler, ConsumerRuntime],
})
export class EventsModule {}

/**
 * Maps a thrown domain error onto the DLQ `reason` it is parked under.
 *
 * `null` means "keep retrying": `NotFoundException` is deliberately *not* in
 * this list. A reservation that a checkout has just created may simply not be
 * visible yet, so the old hand-written consumer retried it five times before
 * giving up, and this one keeps that ladder. The cost of the preserved ladder is
 * the label: the shared protocol hard-codes `transient-exhausted` for an
 * exhausted retry, so a missing hold now arrives as `transient-exhausted`
 * instead of `reservation-missing`. The error text still names the reservation,
 * and no order is lost — which is the trade this wave chose over dead-lettering
 * a hold whose transaction had not committed yet.
 */
export function dlqReason(error: unknown): string | null {
  if (error instanceof ReservationClosedError) return 'reservation-closed';
  if (error instanceof ReservationMismatchError) return 'reservation-mismatch';
  if (error instanceof ProductImportRejectedError) return error.reason;
  return null;
}

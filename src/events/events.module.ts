import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StockModule } from '../stock/stock.module.js';
import { ConsumerMetrics } from './consumer-metrics.js';
import { ConsumerStatsController } from './consumer-stats.controller.js';
import { EVENT_BUS_TOKEN } from './event-bus/event-bus.interface.js';
import { KafkaEventBus } from './event-bus/kafka-event-bus.js';
import { InMemoryEventBus } from './event-bus/in-memory-event-bus.js';
import { EventsService } from './events.service.js';
import { KafkaOrderConsumer } from './order-created/kafka-order-consumer.js';
import { OrderCreatedHandler } from './order-created/order-created.handler.js';

@Global()
@Module({
  // The handler owns the transaction, but the repository that runs it lives in
  // StockModule and is only reachable if that module is imported here.
  imports: [StockModule],
  controllers: [ConsumerStatsController],
  providers: [
    {
      provide: EVENT_BUS_TOKEN,
      useFactory: (configService: ConfigService) => {
        const brokers = configService.get<string>('KAFKA_BROKERS');
        if (process.env.NODE_ENV === 'test' || !brokers) {
          return new InMemoryEventBus();
        }
        return new KafkaEventBus(configService);
      },
      inject: [ConfigService],
    },
    EventsService,
    ConsumerMetrics,
    OrderCreatedHandler,
    KafkaOrderConsumer,
  ],
  exports: [EVENT_BUS_TOKEN, EventsService],
})
export class EventsModule {}


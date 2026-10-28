import { Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@ecom/contracts';
import type { IEventBus } from './event-bus.interface.js';

@Injectable()
export class InMemoryEventBus implements IEventBus {
  private readonly logger = new Logger(InMemoryEventBus.name);
  public readonly publishedEvents: {
    topic: string;
    event: EventEnvelope;
    key?: string;
  }[] = [];

  async publish(
    topic: string,
    event: EventEnvelope,
    key?: string,
  ): Promise<void> {
    this.publishedEvents.push({ topic, event, key });
    this.logger.debug(
      `[InMemoryEventBus] Published ${event.eventType} on ${topic} (key: ${key ?? 'none'})`,
    );
  }

  clear(): void {
    this.publishedEvents.length = 0;
  }
}

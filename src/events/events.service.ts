import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CategoryUpdatedPayload,
  EventEnvelope,
  ProductUpdatedPayload,
} from '@ecom/contracts';
import {
  EVENT_BUS_TOKEN,
  type IEventBus,
} from './event-bus/event-bus.interface.js';

@Injectable()
export class EventsService {
  constructor(
    @Inject(EVENT_BUS_TOKEN)
    private readonly eventBus: IEventBus,
  ) {}

  async publishProductUpdated(payload: ProductUpdatedPayload): Promise<void> {
    const envelope: EventEnvelope = {
      id: randomUUID(),
      topic: 'product.updated',
      eventType: 'product.updated',
      producer: 'catalog-svc',
      timestamp: new Date().toISOString(),
      payload: { ...payload },
    };
    await this.eventBus.publish('product.updated', envelope, payload.productId);
  }

  async publishCategoryUpdated(payload: CategoryUpdatedPayload): Promise<void> {
    const envelope: EventEnvelope = {
      id: randomUUID(),
      topic: 'category.updated',
      eventType: 'category.updated',
      producer: 'catalog-svc',
      timestamp: new Date().toISOString(),
      payload: { ...payload },
    };
    await this.eventBus.publish(
      'category.updated',
      envelope,
      payload.categoryId,
    );
  }
}

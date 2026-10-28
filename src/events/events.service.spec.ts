import { describe, expect, it, vi } from 'vitest';
import { EventsService } from './events.service.js';
import type { IEventBus } from './event-bus/event-bus.interface.js';

describe('EventsService (catalog-svc)', () => {
  it('publishes product.updated with correct envelope and topic', async () => {
    const publishSpy = vi.fn().mockResolvedValue(undefined);
    const eventBus: IEventBus = {
      publish: publishSpy,
    };
    const service = new EventsService(eventBus);

    await service.publishProductUpdated({
      productId: '0190a8b0-0000-7000-8000-000000000101',
      sku: 'TEST-SKU',
      name: 'Test Product',
      slug: 'test-product',
      price: 99.99,
      status: 'active',
      updatedAt: '2026-10-28T12:00:00.000Z',
    });

    expect(publishSpy).toHaveBeenCalledWith(
      'product.updated',
      expect.objectContaining({
        topic: 'product.updated',
        eventType: 'product.updated',
        producer: 'catalog-svc',
        payload: expect.objectContaining({
          productId: '0190a8b0-0000-7000-8000-000000000101',
          name: 'Test Product',
        }),
      }),
      '0190a8b0-0000-7000-8000-000000000101',
    );
  });

  it('publishes category.updated with correct envelope and topic', async () => {
    const publishSpy = vi.fn().mockResolvedValue(undefined);
    const eventBus: IEventBus = {
      publish: publishSpy,
    };
    const service = new EventsService(eventBus);

    await service.publishCategoryUpdated({
      categoryId: '0190a8b0-0000-7000-8000-000000000001',
      name: 'Test Category',
      slug: 'test-category',
      isActive: true,
      updatedAt: '2026-10-28T12:00:00.000Z',
    });

    expect(publishSpy).toHaveBeenCalledWith(
      'category.updated',
      expect.objectContaining({
        topic: 'category.updated',
        eventType: 'category.updated',
        producer: 'catalog-svc',
        payload: expect.objectContaining({
          categoryId: '0190a8b0-0000-7000-8000-000000000001',
          slug: 'test-category',
        }),
      }),
      '0190a8b0-0000-7000-8000-000000000001',
    );
  });
});

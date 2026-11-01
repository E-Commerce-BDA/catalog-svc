import { NotFoundException } from '@nestjs/common';
import type { KafkaContext } from '@nestjs/microservices';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConsumerMetrics,
  KafkaDlqPublisher,
  RecordingLogger,
  type KafkaProducerLike,
} from '@ecom/messaging';
import {
  KafkaConsumerStalledError,
  KafkaEventHandler,
} from '@ecom/messaging/nest';
import {
  ReservationClosedError,
  ReservationMismatchError,
} from '../stock/stock-reservations.errors.js';
import { CatalogConsumerController } from './catalog-consumer.controller.js';
import { CATALOG_CONSUMER_TOPICS } from './catalog-topics.js';
import { dlqReason } from './events.module.js';
import { ProductImportRejectedError } from './product-imported/import.errors.js';
import type { OrderCreatedHandler } from './order-created/order-created.handler.js';
import type { OrderStatusUpdatedHandler } from './order-status-updated/order-status-updated.handler.js';
import type { ProductImportedHandler } from './product-imported/product-imported.handler.js';

const EVENT_ID = '0190a8b0-0000-7000-8000-00000000e201';
const RESERVATION_ID = '0190a8b0-0000-7000-8000-00000000c001';
const ORDER_ID = '0190a8b0-0000-7000-8000-00000000c002';
const PRODUCT_ID = '0190a8b0-0000-7000-8000-00000000d001';

const orderEnvelope = (overrides: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  type: 'order.created',
  producer: 'order-svc',
  timestamp: '2026-10-30T10:00:01.000Z',
  payload: {
    orderId: ORDER_ID,
    orderNumber: 'ORD-20261030-0001',
    userId: '0190a8b0-0000-7000-8000-00000000a001',
    grandTotal: 129.99,
    itemsCount: 2,
    reservationId: RESERVATION_ID,
    createdAt: '2026-10-30T10:00:00.000Z',
  },
  ...overrides,
});

const importEnvelope = (overrides: Record<string, unknown> = {}) => ({
  id: '0190a8b0-0000-7000-8000-00000000e202',
  type: 'product.imported',
  producer: 'import-svc',
  timestamp: '2026-10-30T10:00:01.000Z',
  payload: {
    productId: PRODUCT_ID,
    sku: 'IMP-001',
    name: 'Imported Widget',
    slug: 'imported-widget',
    price: 19.99,
    stock: 3,
    status: 'active',
    updatedAt: '2026-10-30T10:00:00.000Z',
  },
  ...overrides,
});

const statusEnvelope = (to = 'cancelled', overrides: Record<string, unknown> = {}) => ({
  id: '0190a8b0-0000-7000-8000-00000000e203',
  type: 'order.status.updated',
  producer: 'order-svc',
  timestamp: '2026-10-30T10:00:02.000Z',
  payload: {
    orderId: ORDER_ID,
    orderNumber: 'ORD-20261030-0001',
    from: 'pending',
    to,
    timestamp: '2026-10-30T10:00:02.000Z',
  },
  ...overrides,
});

/**
 * The protocol itself is tested in `@ecom/messaging`. What is asserted here is
 * that catalog-svc is wired to it correctly: two routes on one consumer, the
 * right DLQ name per route, which failures are terminal, and the order of side
 * effect → counter → offset.
 *
 * These cases are the ones `cat-007`'s `kafka-order-consumer.spec.ts` covered,
 * re-pointed at the transport that replaced it rather than deleted. One case had
 * to change: an unrouted topic cannot reach a Nest controller at all (the
 * strategy only subscribes the declared patterns), so "consumes an unrouted
 * topic" is gone. One label changed: a retried `NotFoundException` is now
 * `transient-exhausted` instead of `reservation-missing`, because the shared
 * protocol owns the exhaustion reason — `dlqReason` deliberately leaves it
 * retryable, which is what the case below pins.
 */
describe('CatalogConsumerController', () => {
  const order: string[] = [];
  let orders: { handle: ReturnType<typeof vi.fn> };
  let imports: { handle: ReturnType<typeof vi.fn> };
  let statuses: { handle: ReturnType<typeof vi.fn> };
  let metrics: ConsumerMetrics;
  let producer: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  let commitOffsets: ReturnType<typeof vi.fn>;
  let controller: CatalogConsumerController;

  const context = (
    offset: string,
    partition = 0,
    key: string | null = 'key-123',
  ) =>
    ({
      getMessage: () => ({ offset, key }),
      getPartition: () => partition,
      getConsumer: () => ({ commitOffsets }),
    }) as unknown as KafkaContext;

  const sentTopic = (call = 0): string => {
    const [request] = producer.send.mock.calls[call] as [{ topic: string }];
    return request.topic;
  };

  const sentRecord = (call = 0): Record<string, unknown> => {
    const [request] = producer.send.mock.calls[call] as [
      { topic: string; messages: { value: string }[] },
    ];
    return JSON.parse(request.messages[0]!.value) as Record<string, unknown>;
  };

  beforeEach(() => {
    order.length = 0;
    orders = {
      handle: vi.fn().mockResolvedValue({
        kind: 'committed',
        reservationId: RESERVATION_ID,
        orderId: ORDER_ID,
        eventId: EVENT_ID,
        outcome: 'committed',
      }),
    };
    imports = {
      handle: vi.fn().mockResolvedValue({
        kind: 'applied',
        productId: PRODUCT_ID,
        created: true,
        variants: 0,
        images: 0,
        stockFigures: 1,
      }),
    };
    statuses = {
      handle: vi.fn().mockResolvedValue({
        kind: 'released',
        reservationId: RESERVATION_ID,
        orderId: ORDER_ID,
        eventId: EVENT_ID,
        outcome: 'released',
      }),
    };
    metrics = new ConsumerMetrics();

    commitOffsets = vi.fn().mockImplementation(() => {
      order.push('commit');
      return Promise.resolve();
    });
    producer = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockImplementation(() => {
        order.push('dlq');
        return Promise.resolve({});
      }),
    };

    const dlq = new KafkaDlqPublisher({
      brokers: ['localhost:9092'],
      clientId: 'catalog-svc-test',
      producer: producer as KafkaProducerLike,
      clock: () => new Date('2026-10-30T12:00:00.000Z'),
    });

    const handler = new KafkaEventHandler({
      dlq,
      metrics,
      logger: new RecordingLogger(),
      maxRetries: 2,
      retryDelaysMs: [1, 2],
      // The real factory's translateError, so a change there breaks a test.
      translateError: dlqReason,
      sleep: async () => {
        order.push('sleep');
      },
    });

    controller = new CatalogConsumerController(
      handler,
      orders as unknown as OrderCreatedHandler,
      imports as unknown as ProductImportedHandler,
      statuses as unknown as OrderStatusUpdatedHandler,
    );
  });

  it('commits the order offset after a committed reservation and counts it as committed', async () => {
    orders.handle.mockResolvedValue({
      kind: 'committed',
      reservationId: RESERVATION_ID,
      orderId: ORDER_ID,
      eventId: EVENT_ID,
      outcome: 'committed',
    });

    await controller.onOrderCreated(
      JSON.stringify(orderEnvelope()),
      context('42'),
    );

    expect(orders.handle).toHaveBeenCalledWith(orderEnvelope());
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: 'order.created', partition: 0, offset: '43' },
    ]);
    expect(producer.send).not.toHaveBeenCalled();
    // `committed`, not `accepted`: cat-007's dashboard reads that name.
    expect(metrics.snapshot()).toMatchObject({ committed: 1, accepted: 0, dlq: 0 });
  });

  it('routes malformed JSON to order.created.dlq and commits the offset', async () => {
    await controller.onOrderCreated(
      'not-valid-json{[[[',
      context('10', 0, null),
    );

    expect(orders.handle).not.toHaveBeenCalled();
    expect(sentTopic()).toBe('order.created.dlq');

    const record = sentRecord();
    expect(record.reason).toBe('invalid-json');
    expect(record.rawValue).toBe('not-valid-json{[[[');
    expect(record.source).toEqual({
      topic: 'order.created',
      partition: 0,
      offset: '10',
    });

    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: 'order.created', partition: 0, offset: '11' },
    ]);
    expect(metrics.snapshot()).toMatchObject({ invalid: 1, dlq: 1 });
  });

  it('routes an invalid payload to the DLQ without retrying', async () => {
    orders.handle.mockResolvedValue({
      kind: 'invalid',
      stage: 'payload',
      error: 'reservationId: must be a uuid',
    });

    await controller.onOrderCreated(
      JSON.stringify(orderEnvelope()),
      context('70', 2),
    );

    // A malformed payload can never succeed, so it must not enter the ladder.
    expect(orders.handle).toHaveBeenCalledTimes(1);
    expect(producer.send).toHaveBeenCalledTimes(1);
    expect(sentRecord().reason).toBe('invalid-payload');
    expect(sentRecord().error).toBe('reservationId: must be a uuid');
    expect(sentRecord().originalPayload).toMatchObject({
      type: 'order.created',
    });
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: 'order.created', partition: 2, offset: '71' },
    ]);
    expect(metrics.snapshot()).toMatchObject({ invalid: 1, dlq: 1 });
  });

  it('labels an envelope-stage rejection as invalid-envelope', async () => {
    orders.handle.mockResolvedValue({
      kind: 'invalid',
      stage: 'envelope',
      error: 'producer: Required',
    });

    await controller.onOrderCreated(JSON.stringify({ id: 'x' }), context('5'));

    expect(sentRecord().reason).toBe('invalid-envelope');
  });

  it('commits a duplicate and a no-reservation ignore without a DLQ write', async () => {
    orders.handle
      .mockResolvedValueOnce({ kind: 'duplicate', eventId: EVENT_ID })
      .mockResolvedValueOnce({ kind: 'ignored', reason: 'no-reservation' });

    await controller.onOrderCreated(
      JSON.stringify(orderEnvelope()),
      context('80'),
    );
    await controller.onOrderCreated(
      JSON.stringify(orderEnvelope()),
      context('81'),
    );

    expect(producer.send).not.toHaveBeenCalled();
    expect(commitOffsets).toHaveBeenCalledTimes(2);
    expect(metrics.snapshot()).toMatchObject({
      duplicate: 1,
      ignored: 1,
      dlq: 0,
    });
  });

  it('dead-letters a released hold immediately instead of retrying', async () => {
    orders.handle.mockRejectedValue(
      new ReservationClosedError(RESERVATION_ID, 'released'),
    );

    await controller.onOrderCreated(
      JSON.stringify(orderEnvelope()),
      context('42', 1),
    );

    expect(orders.handle).toHaveBeenCalledTimes(1);
    expect(sentRecord().reason).toBe('reservation-closed');
    expect(sentRecord().error).toContain('already released');
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: 'order.created', partition: 1, offset: '43' },
    ]);
    expect(metrics.snapshot()).toMatchObject({ dlq: 1, committed: 0 });
  });

  it('dead-letters a reservation owned by another order', async () => {
    orders.handle.mockRejectedValue(
      new ReservationMismatchError(RESERVATION_ID, ORDER_ID, EVENT_ID),
    );

    await controller.onOrderCreated(
      JSON.stringify(orderEnvelope()),
      context('42'),
    );

    expect(orders.handle).toHaveBeenCalledTimes(1);
    expect(sentRecord().reason).toBe('reservation-mismatch');
  });

  it('retries a missing reservation and labels the exhaustion transient-exhausted', async () => {
    orders.handle.mockRejectedValue(new NotFoundException('Reservation gone'));

    await controller.onOrderCreated(
      JSON.stringify(orderEnvelope()),
      context('42'),
    );

    // 1 attempt + 2 retries: a hold that has not committed yet is worth waiting
    // for, which is why `dlqReason` does not make a 404 terminal. The label is
    // the shared protocol's, so it is `transient-exhausted` and not
    // `reservation-missing` — the reason text still names the reservation.
    expect(orders.handle).toHaveBeenCalledTimes(3);
    expect(sentRecord().reason).toBe('transient-exhausted');
    expect(sentRecord().error).toBe('Reservation gone');
    expect(order).toEqual(['sleep', 'sleep', 'dlq', 'commit']);
  });

  it('recovers when the hold lands on a retry', async () => {
    orders.handle
      .mockRejectedValueOnce(new NotFoundException('Not yet'))
      .mockResolvedValueOnce({
        kind: 'committed',
        reservationId: RESERVATION_ID,
        orderId: ORDER_ID,
        eventId: EVENT_ID,
        outcome: 'committed',
      });

    await controller.onOrderCreated(
      JSON.stringify(orderEnvelope()),
      context('42'),
    );

    expect(orders.handle).toHaveBeenCalledTimes(2);
    expect(producer.send).not.toHaveBeenCalled();
    expect(metrics.snapshot()).toMatchObject({ committed: 1, dlq: 0 });
  });

  it('exhausts retries on a transient failure, dead-letters, and only then commits', async () => {
    orders.handle.mockRejectedValue(new Error('connection terminated'));

    await controller.onOrderCreated(
      JSON.stringify(orderEnvelope()),
      context('200', 1, 'b-1'),
    );

    expect(orders.handle).toHaveBeenCalledTimes(3);
    expect(sentRecord().reason).toBe('transient-exhausted');
    expect(sentRecord().error).toBe('connection terminated');
    expect(order).toEqual(['sleep', 'sleep', 'dlq', 'commit']);
    expect(metrics.snapshot()).toMatchObject({ dlq: 1, stalled: 0 });
  });

  it('does NOT commit when the dead letter itself fails', async () => {
    orders.handle.mockRejectedValue(new Error('processing failure'));
    producer.send.mockRejectedValue(new Error('dlq broker unavailable'));

    await expect(
      controller.onOrderCreated(
        JSON.stringify(orderEnvelope()),
        context('50'),
      ),
    ).rejects.toBeInstanceOf(KafkaConsumerStalledError);

    expect(commitOffsets).not.toHaveBeenCalled();
    expect(metrics.snapshot()).toMatchObject({ dlq: 0, stalled: 1 });
  });

  it('applies a product import, commits and reports it as accepted', async () => {
    await controller.onProductImported(
      JSON.stringify(importEnvelope()),
      context('12', 3),
    );

    expect(imports.handle).toHaveBeenCalledWith(importEnvelope());
    // One consumer, one offset: the import route commits on the same group.
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: 'product.imported', partition: 3, offset: '13' },
    ]);
    expect(producer.send).not.toHaveBeenCalled();
    expect(metrics.snapshot()).toMatchObject({ accepted: 1, dlq: 0 });
  });

  it('dead-letters a rejected import immediately, under its own reason', async () => {
    imports.handle.mockRejectedValue(
      new ProductImportRejectedError(
        'unresolved-reference',
        'Category 0190a8b0-0000-7000-8000-00000000ffff does not exist',
      ),
    );

    await controller.onProductImported(
      JSON.stringify(importEnvelope()),
      context('30', 0),
    );

    // Terminal: an id that does not exist will still not exist 31s later.
    expect(imports.handle).toHaveBeenCalledTimes(1);
    expect(sentTopic()).toBe('product.imported.dlq');
    expect(sentRecord().reason).toBe('unresolved-reference');
    expect(order).toEqual(['dlq', 'commit']);
  });

  it('routes malformed import JSON to product.imported.dlq', async () => {
    await controller.onProductImported('{oops', context('8', 1, null));

    expect(imports.handle).not.toHaveBeenCalled();
    expect(sentTopic()).toBe('product.imported.dlq');
    expect(sentRecord().reason).toBe('invalid-json');
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: 'product.imported', partition: 1, offset: '9' },
    ]);
  });

  it('does not commit a malformed JSON offset when the DLQ write fails', async () => {
    producer.send.mockRejectedValue(new Error('dlq broker unavailable'));

    await expect(
      controller.onOrderCreated('{oops', context('7', 0, null)),
    ).rejects.toBeInstanceOf(KafkaConsumerStalledError);

    expect(commitOffsets).not.toHaveBeenCalled();
    // The counter follows the write, so a failed write is not counted as DLQed.
    expect(metrics.snapshot()).toMatchObject({ invalid: 0, dlq: 0 });
  });

  it('declares every topic the controller routes and the sampler measures', () => {
    // One list feeds the `@EventPattern` strings, the lag sampler and the DLQ
    // names; a topic added to one and not the others is invisible until a
    // cancellation is silently never consumed.
    expect(CATALOG_CONSUMER_TOPICS).toEqual([
      'order.created',
      'product.imported',
      'order.status.updated',
    ]);
  });

  it('releases the reservation on a cancellation and counts it as accepted', async () => {
    await controller.onOrderStatusUpdated(
      JSON.stringify(statusEnvelope('cancelled')),
      context('60', 1),
    );

    expect(statuses.handle).toHaveBeenCalledWith(statusEnvelope('cancelled'));
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: 'order.status.updated', partition: 1, offset: '61' },
    ]);
    expect(producer.send).not.toHaveBeenCalled();
    // `accepted`, not a bespoke name: `AppliedCounter` is a closed union in
    // @ecom/messaging, so a release reports under the protocol's default.
    expect(metrics.snapshot()).toMatchObject({ accepted: 1, dlq: 0 });
  });

  it('dead-letters an invalid status payload to its own topic DLQ', async () => {
    statuses.handle.mockResolvedValue({
      kind: 'invalid',
      stage: 'payload',
      error: 'to: Invalid enum value',
    });

    await controller.onOrderStatusUpdated(
      JSON.stringify(statusEnvelope('shipped')),
      context('20', 2),
    );

    // The explicit topic string is what names the DLQ, so this case fails if the
    // `@EventPattern` and the topic passed to `run` ever disagree.
    expect(sentTopic()).toBe('order.status.updated.dlq');
    expect(sentRecord().reason).toBe('invalid-payload');
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: 'order.status.updated', partition: 2, offset: '21' },
    ]);
  });

  it('commits a status event that is not a release without a DLQ write', async () => {
    statuses.handle.mockResolvedValue({
      kind: 'ignored',
      reason: 'not-release-status',
      status: 'shipped',
    });

    await controller.onOrderStatusUpdated(
      JSON.stringify(statusEnvelope('shipped')),
      context('90'),
    );

    expect(producer.send).not.toHaveBeenCalled();
    expect(commitOffsets).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot()).toMatchObject({ ignored: 1, dlq: 0 });
  });

  it('does not dead-letter a duplicate cancellation', async () => {
    statuses.handle.mockResolvedValue({ kind: 'duplicate', eventId: EVENT_ID });

    await controller.onOrderStatusUpdated(
      JSON.stringify(statusEnvelope()),
      context('91'),
    );

    expect(producer.send).not.toHaveBeenCalled();
    expect(metrics.snapshot()).toMatchObject({ duplicate: 1, dlq: 0 });
  });
});

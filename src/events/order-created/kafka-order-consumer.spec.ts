import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReservationClosedError,
  ReservationMismatchError,
} from '../../stock/stock-reservations.errors.js';
import { ConsumerMetrics } from '../consumer-metrics.js';
import { KafkaOrderConsumer } from './kafka-order-consumer.js';
import type {
  OrderCreatedHandler,
  OrderCreatedOutcome,
} from './order-created.handler.js';

const EVENT_ID = '0190a8b0-0000-7000-8000-00000000e201';
const RESERVATION_ID = '0190a8b0-0000-7000-8000-00000000c001';
const ORDER_ID = '0190a8b0-0000-7000-8000-00000000c002';

const envelope = (overrides: Record<string, unknown> = {}) => ({
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

describe('KafkaOrderConsumer', () => {
  let handler: { handle: ReturnType<typeof vi.fn> };
  let metrics: ConsumerMetrics;
  let consumer: KafkaOrderConsumer;
  let mockConsumerCommit: ReturnType<typeof vi.fn>;
  let mockProducerSend: ReturnType<typeof vi.fn>;

  const sentRecord = (): Record<string, unknown> => {
    const [request] = mockProducerSend.mock.calls[0] as [
      { messages: { value: string }[] },
    ];
    const [message] = request.messages;
    return JSON.parse(message.value) as Record<string, unknown>;
  };

  const message = (value: unknown, offset = '42') => ({
    key: 'order-1',
    value: Buffer.from(
      typeof value === 'string' ? value : JSON.stringify(value),
    ),
    offset,
  });

  beforeEach(() => {
    handler = { handle: vi.fn() };
    metrics = new ConsumerMetrics();

    consumer = new KafkaOrderConsumer(
      handler as unknown as OrderCreatedHandler,
      new ConfigService({ KAFKA_BROKERS: 'localhost:9092' }),
      metrics,
      {
        brokers: ['localhost:9092'],
        maxRetries: 2,
        retryDelaysMs: [1, 2], // fast delays for unit tests
      },
    );

    mockConsumerCommit = vi.fn().mockResolvedValue(undefined);
    mockProducerSend = vi.fn().mockResolvedValue(undefined);

    // Stand in for the kafkajs client so no broker is needed.
    (
      consumer as unknown as {
        consumer: { commitOffsets: typeof mockConsumerCommit };
      }
    ).consumer = { commitOffsets: mockConsumerCommit };
    (
      consumer as unknown as { producer: { send: typeof mockProducerSend } }
    ).producer = { send: mockProducerSend };
  });

  it('commits the offset after a committed outcome', async () => {
    handler.handle.mockResolvedValue({
      kind: 'committed',
      reservationId: RESERVATION_ID,
      orderId: ORDER_ID,
      eventId: EVENT_ID,
      outcome: 'committed',
    } satisfies OrderCreatedOutcome);

    await consumer.processMessage('order.created', 0, message(envelope()));

    expect(handler.handle).toHaveBeenCalledWith(envelope());
    expect(mockConsumerCommit).toHaveBeenCalledWith([
      { topic: 'order.created', partition: 0, offset: '43' },
    ]);
    expect(mockProducerSend).not.toHaveBeenCalled();
    expect(metrics.snapshot()).toMatchObject({ committed: 1, dlq: 0 });
  });

  it('routes malformed JSON to order.created.dlq and commits the offset', async () => {
    await consumer.processMessage(
      'order.created',
      0,
      message('not-valid-json{[[['),
    );

    expect(handler.handle).not.toHaveBeenCalled();
    expect(mockProducerSend).toHaveBeenCalledWith({
      topic: 'order.created.dlq',
      messages: [
        expect.objectContaining({
          value: expect.stringContaining('invalid-json'),
        }),
      ],
    });

    const record = sentRecord();
    expect(record.reason).toBe('invalid-json');
    expect(record.rawValue).toBe('not-valid-json{[[[');
    expect(record.source).toEqual({
      topic: 'order.created',
      partition: 0,
      offset: '42',
    });

    expect(mockConsumerCommit).toHaveBeenCalledWith([
      { topic: 'order.created', partition: 0, offset: '43' },
    ]);
    expect(metrics.snapshot()).toMatchObject({ invalid: 1, dlq: 1 });
  });

  it('routes an invalid payload to the DLQ without retrying', async () => {
    handler.handle.mockResolvedValue({
      kind: 'invalid',
      stage: 'payload',
      error: 'reservationId: must be a uuid',
    } satisfies OrderCreatedOutcome);

    await consumer.processMessage('order.created', 2, message(envelope(), '70'));

    // A malformed payload can never succeed, so it must not enter the ladder.
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(sentRecord().reason).toBe('invalid-payload');
    expect(sentRecord().originalPayload).toMatchObject({
      type: 'order.created',
    });
    expect(mockConsumerCommit).toHaveBeenCalledWith([
      { topic: 'order.created', partition: 2, offset: '71' },
    ]);
    expect(metrics.snapshot()).toMatchObject({ invalid: 1, dlq: 1 });
  });

  it('labels an envelope-stage rejection as invalid-envelope', async () => {
    handler.handle.mockResolvedValue({
      kind: 'invalid',
      stage: 'envelope',
      error: 'producer: Required',
    } satisfies OrderCreatedOutcome);

    await consumer.processMessage('order.created', 0, message({ id: 'x' }));

    expect(sentRecord().reason).toBe('invalid-envelope');
  });

  it('commits a duplicate and a no-reservation ignore without a DLQ write', async () => {
    handler.handle
      .mockResolvedValueOnce({ kind: 'duplicate', eventId: EVENT_ID })
      .mockResolvedValueOnce({ kind: 'ignored', reason: 'no-reservation' });

    await consumer.processMessage('order.created', 0, message(envelope()));
    await consumer.processMessage('order.created', 0, message(envelope(), '43'));

    expect(mockProducerSend).not.toHaveBeenCalled();
    expect(mockConsumerCommit).toHaveBeenCalledTimes(2);
    expect(metrics.snapshot()).toMatchObject({
      duplicate: 1,
      ignored: 1,
      dlq: 0,
    });
  });

  it('dead-letters a released hold immediately instead of retrying', async () => {
    handler.handle.mockRejectedValue(
      new ReservationClosedError(RESERVATION_ID, 'released'),
    );

    await consumer.processMessage('order.created', 1, message(envelope()));

    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(sentRecord().reason).toBe('reservation-closed');
    expect(sentRecord().error).toContain('already released');
    expect(mockConsumerCommit).toHaveBeenCalledWith([
      { topic: 'order.created', partition: 1, offset: '43' },
    ]);
    expect(metrics.snapshot()).toMatchObject({ dlq: 1, committed: 0 });
  });

  it('dead-letters a reservation owned by another order', async () => {
    handler.handle.mockRejectedValue(
      new ReservationMismatchError(RESERVATION_ID, ORDER_ID, EVENT_ID),
    );

    await consumer.processMessage('order.created', 0, message(envelope()));

    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(sentRecord().reason).toBe('reservation-mismatch');
  });

  it('retries a missing reservation and labels the exhaustion reservation-missing', async () => {
    handler.handle.mockRejectedValue(new NotFoundException('Reservation gone'));

    await consumer.processMessage('order.created', 0, message(envelope()));

    // 1 initial + 2 retries = 3 attempts
    expect(handler.handle).toHaveBeenCalledTimes(3);
    expect(sentRecord().reason).toBe('reservation-missing');
    expect(mockConsumerCommit).toHaveBeenCalledWith([
      { topic: 'order.created', partition: 0, offset: '43' },
    ]);
  });

  it('recovers when the hold lands on a retry', async () => {
    handler.handle.mockRejectedValueOnce(new NotFoundException('Not yet'));
    handler.handle.mockResolvedValueOnce({
      kind: 'committed',
      reservationId: RESERVATION_ID,
      orderId: ORDER_ID,
      eventId: EVENT_ID,
      outcome: 'committed',
    } satisfies OrderCreatedOutcome);

    await consumer.processMessage('order.created', 0, message(envelope()));

    expect(handler.handle).toHaveBeenCalledTimes(2);
    expect(mockProducerSend).not.toHaveBeenCalled();
    expect(metrics.snapshot()).toMatchObject({ committed: 1, dlq: 0 });
  });

  it('labels a non-reservation failure transient-exhausted', async () => {
    handler.handle.mockRejectedValue(new Error('connection terminated'));

    await consumer.processMessage('order.created', 1, message(envelope()));

    expect(handler.handle).toHaveBeenCalledTimes(3);
    expect(sentRecord().reason).toBe('transient-exhausted');
    expect(sentRecord().error).toBe('connection terminated');
  });

  it('consumes an unrouted topic without a side effect or a DLQ record', async () => {
    await consumer.processMessage('product.updated', 0, message(envelope()));

    expect(handler.handle).not.toHaveBeenCalled();
    expect(mockProducerSend).not.toHaveBeenCalled();
    expect(mockConsumerCommit).toHaveBeenCalledWith([
      { topic: 'product.updated', partition: 0, offset: '43' },
    ]);
    expect(metrics.snapshot()).toMatchObject({ ignored: 1 });
  });

  it('does NOT commit the offset when the DLQ publish fails', async () => {
    handler.handle.mockRejectedValue(
      new ReservationClosedError(RESERVATION_ID, 'expired'),
    );
    mockProducerSend.mockRejectedValue(new Error('dlq broker unavailable'));

    await expect(
      consumer.processMessage('order.created', 0, message(envelope())),
    ).rejects.toThrow('dlq broker unavailable');

    expect(mockConsumerCommit).not.toHaveBeenCalled();
    // The counter follows the write, so a failed write is not counted as DLQed.
    expect(metrics.snapshot()).toMatchObject({ dlq: 0 });
  });

  it('does not commit a malformed JSON offset when the DLQ write fails', async () => {
    mockProducerSend.mockRejectedValue(new Error('dlq broker unavailable'));

    await expect(
      consumer.processMessage('order.created', 0, message('{oops')),
    ).rejects.toThrow('dlq broker unavailable');

    expect(mockConsumerCommit).not.toHaveBeenCalled();
    expect(metrics.snapshot()).toMatchObject({ invalid: 0, dlq: 0 });
  });
});

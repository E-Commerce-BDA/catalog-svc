import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReservationClosedError,
  ReservationMismatchError,
} from '../../stock/stock-reservations.errors.js';
import type { StockReservationsRepository } from '../../stock/stock-reservations.repository.js';
import { OrderCreatedHandler } from './order-created.handler.js';

const EVENT_ID = '0190a8b0-0000-7000-8000-00000000e201';
const RESERVATION_ID = '0190a8b0-0000-7000-8000-00000000c001';
const ORDER_ID = '0190a8b0-0000-7000-8000-00000000c002';
const OTHER_ORDER_ID = '0190a8b0-0000-7000-8000-00000000c003';

const payload = (overrides: Record<string, unknown> = {}) => ({
  orderId: ORDER_ID,
  orderNumber: 'ORD-20261030-0001',
  userId: '0190a8b0-0000-7000-8000-00000000a001',
  grandTotal: 129.99,
  itemsCount: 2,
  reservationId: RESERVATION_ID,
  createdAt: '2026-10-30T10:00:00.000Z',
  ...overrides,
});

const envelope = (overrides: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  type: 'order.created',
  producer: 'order-svc',
  timestamp: '2026-10-30T10:00:01.000Z',
  payload: payload(),
  ...overrides,
});

describe('OrderCreatedHandler', () => {
  let reservations: {
    withTransaction: ReturnType<typeof vi.fn>;
    markProcessed: ReturnType<typeof vi.fn>;
    commitInTransaction: ReturnType<typeof vi.fn>;
  };
  let handler: OrderCreatedHandler;

  beforeEach(() => {
    reservations = {
      withTransaction: vi.fn(async (fn: (client: unknown) => unknown) =>
        fn({ id: 'client-1' }),
      ),
      markProcessed: vi.fn().mockResolvedValue(true),
      commitInTransaction: vi.fn().mockResolvedValue({
        outcome: 'committed',
        reservationId: RESERVATION_ID,
        orderId: ORDER_ID,
      }),
    };

    handler = new OrderCreatedHandler(
      reservations as unknown as StockReservationsRepository,
    );
  });

  it('commits the reservation and reports the order id', async () => {
    const outcome = await handler.handle(envelope());

    expect(outcome).toEqual({
      kind: 'committed',
      reservationId: RESERVATION_ID,
      orderId: ORDER_ID,
      eventId: EVENT_ID,
      outcome: 'committed',
    });
    expect(reservations.markProcessed).toHaveBeenCalledWith(
      { id: 'client-1' },
      EVENT_ID,
      'order.created',
    );
    expect(reservations.commitInTransaction).toHaveBeenCalledWith(
      { id: 'client-1' },
      RESERVATION_ID,
      ORDER_ID,
    );
  });

  it('reports an idempotent replay of a committed hold as already-committed', async () => {
    reservations.commitInTransaction.mockResolvedValue({
      outcome: 'already-committed',
      reservationId: RESERVATION_ID,
      orderId: ORDER_ID,
    });

    const outcome = await handler.handle(envelope({ id: OTHER_ORDER_ID }));

    expect(outcome).toMatchObject({
      kind: 'committed',
      outcome: 'already-committed',
    });
  });

  it('treats a replayed event id as a duplicate without touching the reservation', async () => {
    reservations.markProcessed.mockResolvedValue(false);

    const outcome = await handler.handle(envelope());

    expect(outcome).toEqual({ kind: 'duplicate', eventId: EVENT_ID });
    expect(reservations.commitInTransaction).not.toHaveBeenCalled();
  });

  it('ignores an order that never held stock', async () => {
    const outcome = await handler.handle(
      envelope({ payload: payload({ reservationId: '' }) }),
    );

    expect(outcome).toEqual({ kind: 'ignored', reason: 'no-reservation' });
    // Nothing to commit means no transaction at all.
    expect(reservations.withTransaction).not.toHaveBeenCalled();
  });

  it('ignores a topic this handler is not subscribed to', async () => {
    const outcome = await handler.handle(
      envelope({ type: 'order.status.updated' }),
    );

    expect(outcome).toEqual({
      kind: 'ignored',
      reason: 'not-subscribed',
      type: 'order.status.updated',
    });
    expect(reservations.withTransaction).not.toHaveBeenCalled();
  });

  it('accepts the legacy topic/eventType dual-write', async () => {
    const legacy = {
      id: EVENT_ID,
      topic: 'order.created',
      eventType: 'order.created',
      producer: 'order-svc',
      timestamp: '2026-10-30T10:00:01.000Z',
      payload: payload(),
    };

    const outcome = await handler.handle(legacy);

    expect(outcome).toMatchObject({ kind: 'committed' });
  });

  it('reports an unreadable envelope as invalid without opening a transaction', async () => {
    const outcome = await handler.handle({ id: 'not-a-uuid', payload: {} });

    expect(outcome).toMatchObject({ kind: 'invalid', stage: 'envelope' });
    expect(reservations.withTransaction).not.toHaveBeenCalled();
  });

  it('reports a drifted payload with a clipped issue list', async () => {
    const outcome = await handler.handle(
      envelope({ payload: payload({ reservationId: 'not-a-uuid' }) }),
    );

    expect(outcome).toMatchObject({ kind: 'invalid', stage: 'payload' });
    if (outcome.kind !== 'invalid') throw new Error('expected invalid');
    expect(outcome.error).toContain('reservationId');
    expect(outcome.error.length).toBeLessThanOrEqual(301);
    expect(reservations.withTransaction).not.toHaveBeenCalled();
  });

  it('throws when the hold was already released so the claim rolls back', async () => {
    reservations.commitInTransaction.mockRejectedValue(
      new ReservationClosedError(RESERVATION_ID, 'released'),
    );

    await expect(handler.handle(envelope())).rejects.toBeInstanceOf(
      ReservationClosedError,
    );
  });

  it('throws when the hold belongs to another order', async () => {
    reservations.commitInTransaction.mockRejectedValue(
      new ReservationMismatchError(RESERVATION_ID, ORDER_ID, OTHER_ORDER_ID),
    );

    await expect(handler.handle(envelope())).rejects.toBeInstanceOf(
      ReservationMismatchError,
    );
  });

  it('propagates a missing reservation so the consumer can retry', async () => {
    reservations.commitInTransaction.mockRejectedValue(
      new NotFoundException('Reservation not found'),
    );

    await expect(handler.handle(envelope())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

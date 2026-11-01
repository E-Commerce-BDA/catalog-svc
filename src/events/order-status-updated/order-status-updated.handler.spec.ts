import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StockReservationsRepository } from '../../stock/stock-reservations.repository.js';
import { OrderStatusUpdatedHandler } from './order-status-updated.handler.js';

const EVENT_ID = '0190a8b0-0000-7000-8000-00000000e203';
const RESERVATION_ID = '0190a8b0-0000-7000-8000-00000000c001';
const ORDER_ID = '0190a8b0-0000-7000-8000-00000000c002';

const payload = (overrides: Record<string, unknown> = {}) => ({
  orderId: ORDER_ID,
  orderNumber: 'ORD-20261030-0001',
  from: 'pending',
  to: 'cancelled',
  timestamp: '2026-10-30T10:00:02.000Z',
  ...overrides,
});

const envelope = (overrides: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  type: 'order.status.updated',
  producer: 'order-svc',
  timestamp: '2026-10-30T10:00:02.000Z',
  payload: payload(),
  ...overrides,
});

const reservationRow = (
  status: 'held' | 'committed' | 'released' | 'expired' | 'refunded',
) => ({
  id: RESERVATION_ID,
  order_id: ORDER_ID,
  status,
  items: [
    {
      productId: '0190a8b0-0000-7000-8000-00000000d001',
      variantId: null,
      quantity: 2,
      remainingStock: 4,
    },
  ],
  expires_at: new Date('2026-10-30T10:15:00.000Z'),
  created_at: new Date('2026-10-30T10:00:00.000Z'),
});

describe('OrderStatusUpdatedHandler', () => {
  let reservations: {
    withTransaction: ReturnType<typeof vi.fn>;
    markProcessed: ReturnType<typeof vi.fn>;
    findByOrderIdForUpdate: ReturnType<typeof vi.fn>;
    releaseInTransaction: ReturnType<typeof vi.fn>;
    restockRefundInTransaction: ReturnType<typeof vi.fn>;
  };
  let handler: OrderStatusUpdatedHandler;

  beforeEach(() => {
    reservations = {
      withTransaction: vi.fn(async (fn: (client: unknown) => unknown) =>
        fn({ id: 'client-1' }),
      ),
      markProcessed: vi.fn().mockResolvedValue(true),
      findByOrderIdForUpdate: vi
        .fn()
        .mockResolvedValue(reservationRow('held')),
      releaseInTransaction: vi.fn().mockResolvedValue({
        kind: 'released',
        reservationId: RESERVATION_ID,
        items: [
          {
            productId: '0190a8b0-0000-7000-8000-00000000d001',
            variantId: null,
            quantity: 2,
            restoredStock: 6,
          },
        ],
      }),
      restockRefundInTransaction: vi.fn().mockResolvedValue({
        kind: 'restocked',
        reservationId: RESERVATION_ID,
        items: [
          {
            productId: '0190a8b0-0000-7000-8000-00000000d001',
            variantId: null,
            quantity: 2,
            restoredStock: 6,
          },
        ],
      }),
    };

    handler = new OrderStatusUpdatedHandler(
      reservations as unknown as StockReservationsRepository,
    );
  });

  it('releases the hold a cancellation points at', async () => {
    const outcome = await handler.handle(envelope());

    expect(outcome).toEqual({
      kind: 'released',
      reservationId: RESERVATION_ID,
      orderId: ORDER_ID,
      eventId: EVENT_ID,
      outcome: 'released',
    });
    // The payload carries no reservation id, so the order id is the lookup key.
    expect(reservations.findByOrderIdForUpdate).toHaveBeenCalledWith(
      { id: 'client-1' },
      ORDER_ID,
    );
    expect(reservations.releaseInTransaction).toHaveBeenCalledWith(
      { id: 'client-1' },
      RESERVATION_ID,
    );
    // The claim and the release share one transaction, so a redelivery is a
    // no-op rather than a second restock.
    expect(reservations.markProcessed).toHaveBeenCalledWith(
      { id: 'client-1' },
      EVENT_ID,
      'order.status.updated',
    );
  });

  it('releases on a failure and on a refund, not only on a cancellation', async () => {
    for (const to of ['failed', 'refunded']) {
      const outcome = await handler.handle(
        envelope({ payload: payload({ to }) }),
      );
      expect(outcome).toMatchObject({ kind: 'released' });
    }

    expect(reservations.releaseInTransaction).toHaveBeenCalledTimes(2);
  });

  it('ignores a forward transition without opening a transaction', async () => {
    const outcome = await handler.handle(
      envelope({ payload: payload({ from: 'processing', to: 'shipped' }) }),
    );

    expect(outcome).toEqual({
      kind: 'ignored',
      reason: 'not-release-status',
      status: 'shipped',
    });
    // A shipped order is the common case; it must not cost a transaction.
    expect(reservations.withTransaction).not.toHaveBeenCalled();
  });

  it('ignores a cancellation for an order that never held stock', async () => {
    reservations.findByOrderIdForUpdate.mockResolvedValue(null);

    const outcome = await handler.handle(envelope());

    expect(outcome).toEqual({ kind: 'ignored', reason: 'no-reservation' });
    expect(reservations.releaseInTransaction).not.toHaveBeenCalled();
  });

  it('reports a second release of the same hold as already-released', async () => {
    reservations.findByOrderIdForUpdate.mockResolvedValue(
      reservationRow('released'),
    );
    reservations.releaseInTransaction.mockResolvedValue({
      kind: 'already-released',
      reservationId: RESERVATION_ID,
      status: 'released',
    });

    const outcome = await handler.handle(
      envelope({ id: '0190a8b0-0000-7000-8000-00000000e204' }),
    );

    expect(outcome).toMatchObject({
      kind: 'released',
      outcome: 'already-released',
    });
  });

  it('restocks a committed hold when its order is refunded (cat-012)', async () => {
    reservations.findByOrderIdForUpdate.mockResolvedValue(
      reservationRow('committed'),
    );

    const outcome = await handler.handle(
      envelope({ payload: payload({ to: 'refunded' }) }),
    );

    expect(outcome).toEqual({
      kind: 'restocked',
      reservationId: RESERVATION_ID,
      orderId: ORDER_ID,
      eventId: EVENT_ID,
      outcome: 'restocked',
    });
    // A committed hold has no releasable stock, so the release path is bypassed
    // entirely and the refund-only restock runs instead.
    expect(reservations.restockRefundInTransaction).toHaveBeenCalledWith(
      { id: 'client-1' },
      RESERVATION_ID,
    );
    expect(reservations.releaseInTransaction).not.toHaveBeenCalled();
    // The claim and the restock share one transaction, so a redelivery is a
    // no-op rather than a second restock.
    expect(reservations.markProcessed).toHaveBeenCalledWith(
      { id: 'client-1' },
      EVENT_ID,
      'order.status.updated',
    );
  });

  it('still refuses to restock a committed hold whose order was cancelled', async () => {
    reservations.findByOrderIdForUpdate.mockResolvedValue(
      reservationRow('committed'),
    );
    reservations.releaseInTransaction.mockResolvedValue({
      kind: 'not-releasable',
      reservationId: RESERVATION_ID,
      status: 'committed',
    });

    const outcome = await handler.handle(envelope());

    // Only a refund brings sold units back. A cancellation of a hold that
    // shipped would double-sell, so it stays the logged anomaly, not a restock.
    expect(outcome).toEqual({
      kind: 'ignored',
      reason: 'not-releasable',
      status: 'committed',
      orderId: ORDER_ID,
    });
    expect(reservations.restockRefundInTransaction).not.toHaveBeenCalled();
  });

  it('reports a refund on an already-restocked hold as a no-op', async () => {
    reservations.findByOrderIdForUpdate.mockResolvedValue(
      reservationRow('refunded'),
    );
    reservations.restockRefundInTransaction.mockResolvedValue({
      kind: 'already-restocked',
      reservationId: RESERVATION_ID,
    });

    const outcome = await handler.handle(
      envelope({
        id: '0190a8b0-0000-7000-8000-00000000e205',
        payload: payload({ to: 'refunded' }),
      }),
    );

    // A second refund event (new id) for the same sold hold moves nothing.
    expect(outcome).toMatchObject({
      kind: 'restocked',
      outcome: 'already-restocked',
    });
  });

  it('short-circuits a replayed event id without looking the hold up', async () => {
    reservations.markProcessed.mockResolvedValue(false);

    const outcome = await handler.handle(envelope());

    expect(outcome).toEqual({ kind: 'duplicate', eventId: EVENT_ID });
    expect(reservations.findByOrderIdForUpdate).not.toHaveBeenCalled();
    expect(reservations.releaseInTransaction).not.toHaveBeenCalled();
  });

  it('ignores a topic this handler is not subscribed to', async () => {
    const outcome = await handler.handle(
      envelope({ type: 'order.created' }),
    );

    expect(outcome).toEqual({
      kind: 'ignored',
      reason: 'not-subscribed',
      type: 'order.created',
    });
    expect(reservations.withTransaction).not.toHaveBeenCalled();
  });

  it('reports an unreadable envelope as invalid without opening a transaction', async () => {
    const outcome = await handler.handle({ id: 'not-a-uuid', payload: {} });

    expect(outcome).toMatchObject({ kind: 'invalid', stage: 'envelope' });
    expect(reservations.withTransaction).not.toHaveBeenCalled();
  });

  it('reports a drifted payload with a clipped issue list', async () => {
    const outcome = await handler.handle(
      envelope({ payload: payload({ to: 'teleported' }) }),
    );

    expect(outcome).toMatchObject({ kind: 'invalid', stage: 'payload' });
    if (outcome.kind !== 'invalid') throw new Error('expected invalid');
    expect(outcome.error).toContain('to');
    expect(outcome.error.length).toBeLessThanOrEqual(301);
    expect(reservations.withTransaction).not.toHaveBeenCalled();
  });
});

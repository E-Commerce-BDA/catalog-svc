import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from './../src/app.module.js';
import { closePool, getPool } from './../src/db/pool.js';
import { OrderCreatedHandler } from './../src/events/order-created/order-created.handler.js';
import { OrderStatusUpdatedHandler } from './../src/events/order-status-updated/order-status-updated.handler.js';
import { StockReservationsRepository } from './../src/stock/stock-reservations.repository.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

/**
 * The release consumer's database half, exercised without a broker.
 *
 * What matters here is not that a release restores stock — the HTTP release
 * already did that — but that it stays correct when it arrives twice, when it
 * arrives for a hold that is already gone, and when it arrives *before* the
 * `order.created` it contradicts.
 */
describe('order.status.updated consumer (e2e)', () => {
  let app: INestApplication;
  let handler: OrderStatusUpdatedHandler;
  let orderCreated: OrderCreatedHandler;
  let reservations: StockReservationsRepository;
  const createdProductIds: string[] = [];
  const createdReservationIds: string[] = [];
  const usedEventIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', { exclude: ['health', 'health/ready'] });
    await app.init();

    handler = app.get(OrderStatusUpdatedHandler);
    orderCreated = app.get(OrderCreatedHandler);
    reservations = app.get(StockReservationsRepository);
  });

  afterAll(async () => {
    if (createdProductIds.length > 0) {
      await getPool().query(
        `DELETE FROM catalog.stock_movements WHERE product_id = ANY($1::uuid[])`,
        [createdProductIds],
      );
      await getPool().query(
        `DELETE FROM catalog.stock_reservations WHERE id = ANY($1::uuid[])`,
        [createdReservationIds],
      );
      await getPool().query(
        `DELETE FROM catalog.products WHERE id = ANY($1::uuid[])`,
        [createdProductIds],
      );
    }
    if (usedEventIds.length > 0) {
      await getPool().query(
        `DELETE FROM catalog.processed_events WHERE event_id = ANY($1::varchar[])`,
        [usedEventIds],
      );
    }
    await app.close();
    await closePool();
  });

  async function createProduct(stock: number): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO catalog.products (sku, name, slug, price, stock, status)
       VALUES ($1, 'Order Status Consumer Item', $2, 42.00, $3, 'active')
       RETURNING id`,
      [`SKU-OSC-${suffix}`, `osc-${suffix}`, stock],
    );
    createdProductIds.push(rows[0].id);
    return rows[0].id;
  }

  /**
   * A hold that names its order, which is what production does: checkout
   * generates the order id before it asks catalog for stock.
   */
  async function hold(
    productId: string,
    quantity: number,
    orderId: string,
  ): Promise<string> {
    const reservationId = randomUUID();
    createdReservationIds.push(reservationId);
    await reservations.reserve(
      reservationId,
      [{ productId, quantity }],
      900,
      orderId,
    );
    return reservationId;
  }

  function statusEvent(
    orderId: string,
    to: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const eventId = randomUUID();
    usedEventIds.push(eventId);
    return {
      id: eventId,
      type: 'order.status.updated',
      producer: 'order-svc',
      timestamp: new Date().toISOString(),
      payload: {
        orderId,
        orderNumber: `ORD-${eventId.slice(0, 8)}`,
        from: 'pending',
        to,
        timestamp: new Date().toISOString(),
      },
      ...overrides,
    };
  }

  function orderCreatedEvent(
    reservationId: string,
    orderId: string,
  ): Record<string, unknown> {
    const eventId = randomUUID();
    usedEventIds.push(eventId);
    return {
      id: eventId,
      type: 'order.created',
      producer: 'order-svc',
      timestamp: new Date().toISOString(),
      payload: {
        orderId,
        orderNumber: `ORD-${eventId.slice(0, 8)}`,
        userId: randomUUID(),
        grandTotal: 84,
        itemsCount: 1,
        reservationId,
        createdAt: new Date().toISOString(),
      },
    };
  }

  const stockOf = async (productId: string): Promise<number> => {
    const { rows } = await getPool().query<{ stock: number }>(
      `SELECT stock FROM catalog.products WHERE id = $1`,
      [productId],
    );
    return rows[0].stock;
  };

  const reservationStatus = async (reservationId: string): Promise<string> => {
    const { rows } = await getPool().query<{ status: string }>(
      `SELECT status FROM catalog.stock_reservations WHERE id = $1`,
      [reservationId],
    );
    return rows[0].status;
  };

  /**
   * Sorted, because `stock_movements.id` is a random uuid and `created_at` is
   * `now()`, which is the transaction's start time — two rows written by one
   * transaction share it, so neither column orders them.
   */
  const movementReasons = async (reservationId: string): Promise<string[]> => {
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM catalog.stock_movements
        WHERE reservation_id = $1`,
      [reservationId],
    );
    return rows.map((row) => row.reason).sort();
  };

  const claimCount = async (eventId: string): Promise<number> => {
    const { rows } = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM catalog.processed_events
        WHERE event_id = $1`,
      [eventId],
    );
    return rows[0].count;
  };

  it('restores the stock of a cancelled order and writes a cancel movement', async () => {
    const productId = await createProduct(8);
    const orderId = randomUUID();
    const reservationId = await hold(productId, 3, orderId);

    expect(await stockOf(productId)).toBe(5);

    const outcome = await handler.handle(statusEvent(orderId, 'cancelled'));

    expect(outcome).toMatchObject({
      kind: 'released',
      reservationId,
      orderId,
      outcome: 'released',
    });
    // Restored to the pre-hold figure, not to 8 + 3.
    expect(await stockOf(productId)).toBe(8);
    expect(await reservationStatus(reservationId)).toBe('released');
    expect(await movementReasons(reservationId)).toEqual(['cancel', 'sale']);
  });

  it('restores nothing when the same cancellation is delivered twice', async () => {
    const productId = await createProduct(5);
    const orderId = randomUUID();
    const reservationId = await hold(productId, 2, orderId);
    const event = statusEvent(orderId, 'cancelled');

    await handler.handle(event);
    await expect(handler.handle(event)).resolves.toMatchObject({
      kind: 'duplicate',
    });

    expect(await stockOf(productId)).toBe(5);
    expect(await movementReasons(reservationId)).toEqual(['cancel', 'sale']);
  });

  it('reports a second cancellation of the same order as already released', async () => {
    const productId = await createProduct(4);
    const orderId = randomUUID();
    const reservationId = await hold(productId, 1, orderId);

    await handler.handle(statusEvent(orderId, 'failed'));
    const replay = await handler.handle(statusEvent(orderId, 'cancelled'));

    expect(replay).toMatchObject({
      kind: 'released',
      outcome: 'already-released',
    });
    expect(await stockOf(productId)).toBe(4);
    expect(await movementReasons(reservationId)).toEqual(['cancel', 'sale']);
  });

  it('ignores a forward status without claiming the event', async () => {
    const productId = await createProduct(6);
    const orderId = randomUUID();
    const reservationId = await hold(productId, 2, orderId);
    const event = statusEvent(orderId, 'shipped');

    await expect(handler.handle(event)).resolves.toEqual({
      kind: 'ignored',
      reason: 'not-release-status',
      status: 'shipped',
    });

    expect(await stockOf(productId)).toBe(4);
    expect(await reservationStatus(reservationId)).toBe('held');
    // No transaction at all, so the offset advances without a claim row.
    expect(await claimCount(event.id as string)).toBe(0);
  });

  it('restocks a refund whose hold was already committed, exactly once', async () => {
    const productId = await createProduct(7);
    const orderId = randomUUID();
    const reservationId = await hold(productId, 2, orderId);

    await orderCreated.handle(orderCreatedEvent(reservationId, orderId));
    expect(await reservationStatus(reservationId)).toBe('committed');
    expect(await stockOf(productId)).toBe(5);

    const event = statusEvent(orderId, 'refunded');
    await expect(handler.handle(event)).resolves.toMatchObject({
      kind: 'restocked',
      reservationId,
      orderId,
      outcome: 'restocked',
    });

    // The sold units come back to the pre-sale figure, recorded as a `return`
    // movement and a `refunded` hold — not `cancel`/`released`, which would claim
    // the units never sold.
    expect(await stockOf(productId)).toBe(7);
    expect(await reservationStatus(reservationId)).toBe('refunded');
    expect(await movementReasons(reservationId)).toEqual(['return', 'sale']);
    expect(await claimCount(event.id as string)).toBe(1);

    // A redelivery of the same refund is a no-op: no second restock.
    await expect(handler.handle(event)).resolves.toMatchObject({
      kind: 'duplicate',
    });
    expect(await stockOf(productId)).toBe(7);
    expect(await movementReasons(reservationId)).toEqual(['return', 'sale']);
  });

  it('restocks once when a fresh refund event repeats a settled refund', async () => {
    const productId = await createProduct(6);
    const orderId = randomUUID();
    const reservationId = await hold(productId, 3, orderId);

    await orderCreated.handle(orderCreatedEvent(reservationId, orderId));
    await handler.handle(statusEvent(orderId, 'refunded'));

    // A second refund carrying a NEW event id bypasses the processed-event claim,
    // so it is the `refunded` hold status that keeps the units from doubling.
    await expect(
      handler.handle(statusEvent(orderId, 'refunded')),
    ).resolves.toMatchObject({
      kind: 'restocked',
      outcome: 'already-restocked',
    });

    expect(await stockOf(productId)).toBe(6);
    expect(await movementReasons(reservationId)).toEqual(['return', 'sale']);
  });

  it('does not restock a committed hold whose order was cancelled, not refunded', async () => {
    const productId = await createProduct(7);
    const orderId = randomUUID();
    const reservationId = await hold(productId, 2, orderId);

    await orderCreated.handle(orderCreatedEvent(reservationId, orderId));

    const event = statusEvent(orderId, 'cancelled');
    await expect(handler.handle(event)).resolves.toEqual({
      kind: 'ignored',
      reason: 'not-releasable',
      status: 'committed',
      orderId,
    });

    // Only a refund restocks sold units; a cancellation of a shipped order would
    // double-sell. The hold stays committed and the anomaly is logged once.
    expect(await stockOf(productId)).toBe(5);
    expect(await reservationStatus(reservationId)).toBe('committed');
    expect(await movementReasons(reservationId)).toEqual(['sale']);
    expect(await claimCount(event.id as string)).toBe(1);
  });

  it('lets a cancellation win when it arrives before the commit', async () => {
    const productId = await createProduct(9);
    const orderId = randomUUID();
    const reservationId = await hold(productId, 3, orderId);

    // The race: `order.status.updated` and `order.created` are different topics,
    // so the cancellation is consumed while the hold is still `held`.
    await expect(
      handler.handle(statusEvent(orderId, 'cancelled')),
    ).resolves.toMatchObject({ kind: 'released' });
    expect(await stockOf(productId)).toBe(9);

    // The commit arrives second and must not dead-letter a correct outcome.
    await expect(
      orderCreated.handle(orderCreatedEvent(reservationId, orderId)),
    ).resolves.toEqual({
      kind: 'ignored',
      reason: 'released-by-cancellation',
    });

    expect(await stockOf(productId)).toBe(9);
    expect(await movementReasons(reservationId)).toEqual(['cancel', 'sale']);
  });

  it('ignores a cancellation for an order that never held stock', async () => {
    await expect(
      handler.handle(statusEvent(randomUUID(), 'cancelled')),
    ).resolves.toEqual({ kind: 'ignored', reason: 'no-reservation' });
  });

  it('reports a malformed payload as invalid without claiming it', async () => {
    const event = statusEvent(randomUUID(), 'teleported');

    await expect(handler.handle(event)).resolves.toMatchObject({
      kind: 'invalid',
      stage: 'payload',
    });
    expect(await claimCount(event.id as string)).toBe(0);
  });
});

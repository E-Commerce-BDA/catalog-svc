import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StockReservationsRepository } from './stock-reservations.repository.js';
import { StockReservationsService } from './stock-reservations.service.js';

describe('StockReservationsService', () => {
  let service: StockReservationsService;
  let repo: {
    reserve: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    expireDue: ReturnType<typeof vi.fn>;
  };

  const reservationId = '0190a8b0-0000-7000-8000-0000000000aa';
  const productA = '0190a8b0-0000-7000-8000-000000000001';
  const productB = '0190a8b0-0000-7000-8000-000000000002';

  beforeEach(() => {
    repo = {
      reserve: vi.fn(),
      release: vi.fn(),
      commit: vi.fn(),
      getById: vi.fn(),
      expireDue: vi.fn(),
    };
    const config = {
      get: vi.fn().mockReturnValue(600),
    };
    service = new StockReservationsService(
      repo as unknown as StockReservationsRepository,
      config as unknown as ConfigService,
    );
  });

  it('rejects an empty item list', async () => {
    await expect(service.reserve({ reservationId, items: [] })).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.reserve).not.toHaveBeenCalled();
  });

  it('coalesces duplicate lines and passes the configured ttl', async () => {
    repo.reserve.mockResolvedValueOnce({
      result: {
        reservationId,
        status: 'held',
        expiresAt: new Date().toISOString(),
        items: [],
      },
      replayed: false,
    });

    await service.reserve({
      reservationId,
      items: [
        { productId: productA, quantity: 2 },
        { productId: productA, quantity: 3 },
        { productId: productB, quantity: 1 },
      ],
    });

    expect(repo.reserve).toHaveBeenCalledWith(
      reservationId,
      [
        { productId: productA, variantId: null, quantity: 5 },
        { productId: productB, variantId: null, quantity: 1 },
      ],
      600,
      undefined,
    );
  });

  it('returns the stored result on replay', async () => {
    const stored = {
      reservationId,
      status: 'held' as const,
      expiresAt: '2026-10-29T12:00:00.000Z',
      items: [
        {
          productId: productA,
          variantId: null,
          quantity: 2,
          remainingStock: 8,
        },
      ],
    };
    repo.reserve.mockResolvedValueOnce({ result: stored, replayed: true });

    const res = await service.reserve({
      reservationId,
      items: [{ productId: productA, quantity: 2 }],
    });

    expect(res).toEqual(stored);
  });

  it('delegates release by reservation id', async () => {
    repo.release.mockResolvedValueOnce({
      reservationId,
      status: 'released',
      items: [],
    });

    await service.release({ reservationId });
    expect(repo.release).toHaveBeenCalledWith(reservationId);
  });

  it('delegates commit with the optional order id', async () => {
    repo.commit.mockResolvedValueOnce({
      reservationId,
      status: 'committed',
      orderId: null,
    });

    await service.commit({ reservationId });
    expect(repo.commit).toHaveBeenCalledWith(reservationId, undefined);
  });

  it('throws NotFoundException for an unknown reservation', async () => {
    repo.getById.mockResolvedValueOnce(null);

    await expect(service.getReservation(reservationId)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns expired reservations from the sweep', async () => {
    repo.expireDue.mockResolvedValueOnce([
      { reservationId, releasedItems: [] },
    ]);

    const res = await service.sweepExpired();
    expect(repo.expireDue).toHaveBeenCalledWith(100);
    expect(res).toHaveLength(1);
  });
});

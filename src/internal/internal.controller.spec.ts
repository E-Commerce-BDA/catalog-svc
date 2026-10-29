import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryService } from '../inventory/inventory.service.js';
import { StockReservationsService } from '../stock/stock-reservations.service.js';
import { InternalController } from './internal.controller.js';

describe('InternalController', () => {
  let controller: InternalController;
  let service: {
    getStock: ReturnType<typeof vi.fn>;
    getProductSnapshots: ReturnType<typeof vi.fn>;
  };
  let reservations: {
    reserve: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    getReservation: ReturnType<typeof vi.fn>;
  };

  const reservationId = '0190a8b0-0000-7000-8000-0000000000aa';
  const productId = '0190a8b0-0000-7000-8000-000000000001';

  beforeEach(() => {
    service = {
      getStock: vi.fn(),
      getProductSnapshots: vi.fn(),
    };
    reservations = {
      reserve: vi.fn(),
      release: vi.fn(),
      commit: vi.fn(),
      getReservation: vi.fn(),
    };
    controller = new InternalController(
      service as unknown as InventoryService,
      reservations as unknown as StockReservationsService,
    );
  });

  describe('getStock', () => {
    it('should throw NotFoundException if stock level is not found', async () => {
      service.getStock.mockResolvedValueOnce(null);

      await expect(
        controller.getStock({
          productId: '0190a8b0-0000-7000-8000-000000000001',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return stock level if found', async () => {
      service.getStock.mockResolvedValueOnce({
        productId,
        variantId: null,
        sku: 'SKU-A',
        stock: 5,
        available: true,
      });

      const res = await controller.getStock({ productId });
      expect(res.stock).toBe(5);
      expect(res.available).toBe(true);
    });
  });

  describe('reserveStock', () => {
    it('should delegate to the stock reservation service', async () => {
      reservations.reserve.mockResolvedValueOnce({
        reservationId,
        status: 'held',
        expiresAt: new Date().toISOString(),
        items: [],
      });

      const res = await controller.reserveStock({
        reservationId,
        items: [{ productId, quantity: 2 }],
      });
      expect(reservations.reserve).toHaveBeenCalledWith({
        reservationId,
        items: [{ productId, quantity: 2 }],
      });
      expect(res.reservationId).toBe(reservationId);
    });
  });

  describe('releaseStock', () => {
    it('should delegate to the stock reservation service', async () => {
      reservations.release.mockResolvedValueOnce({
        reservationId,
        status: 'released',
        items: [],
      });

      const res = await controller.releaseStock({ reservationId });
      expect(reservations.release).toHaveBeenCalledWith({ reservationId });
      expect(res.items).toEqual([]);
    });
  });

  describe('commitStock', () => {
    it('should delegate to the stock reservation service', async () => {
      reservations.commit.mockResolvedValueOnce({
        reservationId,
        status: 'committed',
        orderId: null,
      });

      const res = await controller.commitStock({ reservationId });
      expect(res.status).toBe('committed');
    });
  });

  describe('getReservation', () => {
    it('should delegate to the stock reservation service', async () => {
      reservations.getReservation.mockResolvedValueOnce({
        reservationId,
        status: 'held',
        orderId: null,
        expiresAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        items: [],
      });

      const res = await controller.getReservation(reservationId);
      expect(res.status).toBe('held');
    });
  });

  describe('getProducts', () => {
    it('should return empty array if ids param is missing', async () => {
      const res = await controller.getProducts(undefined);
      expect(res).toEqual({ data: [] });
    });

    it('should throw BadRequestException if any id is not a valid UUID', async () => {
      await expect(
        controller.getProducts('invalid-uuid,also-bad'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return snapshots for valid UUIDs', async () => {
      service.getProductSnapshots.mockResolvedValueOnce([
        {
          productId: '0190a8b0-0000-7000-8000-000000000001',
          variantId: null,
          productName: 'Tee',
          productSlug: 'tee',
          sku: 'SKU-TEE',
          imageUrl: null,
          variantLabel: null,
          unitPrice: 20,
          effectivePrice: 20,
          stock: 5,
          available: true,
        },
      ]);

      const res = await controller.getProducts(
        '0190a8b0-0000-7000-8000-000000000001',
      );
      expect(res.data.length).toBe(1);
      expect(res.data[0].productName).toBe('Tee');
      expect(res.data[0].sku).toBe('SKU-TEE');
    });
  });
});

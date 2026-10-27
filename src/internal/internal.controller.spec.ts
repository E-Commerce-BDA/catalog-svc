import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryService } from '../inventory/inventory.service.js';
import { InternalController } from './internal.controller.js';

describe('InternalController', () => {
  let controller: InternalController;
  let service: {
    getStock: ReturnType<typeof vi.fn>;
    reserveStock: ReturnType<typeof vi.fn>;
    releaseStock: ReturnType<typeof vi.fn>;
    getProductSnapshots: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    service = {
      getStock: vi.fn(),
      reserveStock: vi.fn(),
      releaseStock: vi.fn(),
      getProductSnapshots: vi.fn(),
    };
    controller = new InternalController(service as unknown as InventoryService);
  });

  describe('getStock', () => {
    it('should throw NotFoundException if stock level is not found', async () => {
      service.getStock.mockResolvedValueOnce(null);

      await expect(
        controller.getStock({ productId: '0190a8b0-0000-7000-8000-000000000001' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return stock level if found', async () => {
      service.getStock.mockResolvedValueOnce({
        productId: '0190a8b0-0000-7000-8000-000000000001',
        variantId: null,
        sku: 'SKU-A',
        stock: 5,
        available: true,
      });

      const res = await controller.getStock({
        productId: '0190a8b0-0000-7000-8000-000000000001',
      });
      expect(res.stock).toBe(5);
      expect(res.available).toBe(true);
    });
  });

  describe('reserveStock', () => {
    it('should delegate to inventoryService.reserveStock', async () => {
      service.reserveStock.mockResolvedValueOnce({
        reservationId: 'res-1',
        items: [],
      });

      const res = await controller.reserveStock({
        items: [{ productId: '0190a8b0-0000-7000-8000-000000000001', quantity: 2 }],
      });
      expect(res.reservationId).toBe('res-1');
    });
  });

  describe('releaseStock', () => {
    it('should delegate to inventoryService.releaseStock', async () => {
      service.releaseStock.mockResolvedValueOnce({
        items: [],
      });

      const res = await controller.releaseStock({
        items: [{ productId: '0190a8b0-0000-7000-8000-000000000001', quantity: 2 }],
      });
      expect(res.items).toEqual([]);
    });
  });

  describe('getProducts', () => {
    it('should return empty array if ids param is missing', async () => {
      const res = await controller.getProducts(undefined);
      expect(res).toEqual({ data: [] });
    });

    it('should throw BadRequestException if any id is not a valid UUID', async () => {
      await expect(controller.getProducts('invalid-uuid,also-bad')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return snapshots for valid UUIDs', async () => {
      const uuid = '0190a8b0-0000-7000-8000-000000000001';
      service.getProductSnapshots.mockResolvedValueOnce([
        {
          productId: uuid,
          variantId: null,
          productName: 'Tee',
          productSlug: 'tee',
          imageUrl: null,
          variantLabel: null,
          unitPrice: 20,
          effectivePrice: 20,
          stock: 5,
          available: true,
        },
      ]);

      const res = await controller.getProducts(uuid);
      expect(res.data.length).toBe(1);
      expect(res.data[0].productName).toBe('Tee');
    });
  });
});

import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryRepository } from './inventory.repository.js';
import { InventoryService } from './inventory.service.js';

describe('InventoryService', () => {
  let service: InventoryService;
  let repo: {
    getStock: ReturnType<typeof vi.fn>;
    adjustStock: ReturnType<typeof vi.fn>;
    getStockMovements: ReturnType<typeof vi.fn>;
    reserveStock: ReturnType<typeof vi.fn>;
    releaseStock: ReturnType<typeof vi.fn>;
    getProductSnapshots: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    repo = {
      getStock: vi.fn(),
      adjustStock: vi.fn(),
      getStockMovements: vi.fn(),
      reserveStock: vi.fn(),
      releaseStock: vi.fn(),
      getProductSnapshots: vi.fn(),
    };
    service = new InventoryService(repo as unknown as InventoryRepository);
  });

  describe('getStock', () => {
    it('should delegate to repo.getStock', async () => {
      repo.getStock.mockResolvedValueOnce({
        productId: 'prod-1',
        variantId: null,
        sku: 'SKU-1',
        stock: 10,
        available: true,
      });

      const res = await service.getStock('prod-1');
      expect(repo.getStock).toHaveBeenCalledWith('prod-1', undefined);
      expect(res?.stock).toBe(10);
    });
  });

  describe('adjustStock', () => {
    it('should delegate to repo.adjustStock with default reason', async () => {
      repo.adjustStock.mockResolvedValueOnce({
        stock: 15,
        movement: {
          id: 'mov-1',
          productId: 'prod-1',
          variantId: null,
          qtyChange: 5,
          reason: 'admin_adjustment',
          orderId: null,
          qtyAfter: 15,
          createdAt: new Date().toISOString(),
        },
      });

      const res = await service.adjustStock('prod-1', { delta: 5 });
      expect(repo.adjustStock).toHaveBeenCalledWith(
        'prod-1',
        undefined,
        5,
        'admin_adjustment',
      );
      expect(res.stock).toBe(15);
    });
  });

  describe('reserveStock', () => {
    it('should throw BadRequestException if items array is empty', async () => {
      await expect(service.reserveStock({ items: [] })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should delegate to repo.reserveStock', async () => {
      repo.reserveStock.mockResolvedValueOnce({
        reservationId: 'res-1',
        items: [{ productId: 'prod-1', variantId: null, quantity: 2, remainingStock: 8 }],
      });

      const res = await service.reserveStock({
        items: [{ productId: 'prod-1', quantity: 2 }],
      });
      expect(res.reservationId).toBe('res-1');
      expect(res.items[0].remainingStock).toBe(8);
    });
  });

  describe('releaseStock', () => {
    it('should throw BadRequestException if items array is empty', async () => {
      await expect(service.releaseStock({ items: [] })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should delegate to repo.releaseStock', async () => {
      repo.releaseStock.mockResolvedValueOnce({
        items: [{ productId: 'prod-1', variantId: null, quantity: 2, restoredStock: 10 }],
      });

      const res = await service.releaseStock({
        items: [{ productId: 'prod-1', quantity: 2 }],
      });
      expect(res.items[0].restoredStock).toBe(10);
    });
  });

  describe('getProductSnapshots', () => {
    it('should return empty array for empty ids', async () => {
      const res = await service.getProductSnapshots([]);
      expect(res).toEqual([]);
      expect(repo.getProductSnapshots).not.toHaveBeenCalled();
    });

    it('should delegate to repo for non-empty ids', async () => {
      repo.getProductSnapshots.mockResolvedValueOnce([
        {
          productId: 'prod-1',
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

      const res = await service.getProductSnapshots(['prod-1']);
      expect(res.length).toBe(1);
      expect(res[0].productName).toBe('Tee');
    });
  });
});

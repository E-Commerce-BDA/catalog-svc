import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryRepository } from './inventory.repository.js';
import { InventoryService } from './inventory.service.js';

describe('InventoryService', () => {
  let service: InventoryService;
  let repo: {
    getStock: ReturnType<typeof vi.fn>;
    adjustStock: ReturnType<typeof vi.fn>;
    getStockMovements: ReturnType<typeof vi.fn>;
    getProductSnapshots: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    repo = {
      getStock: vi.fn(),
      adjustStock: vi.fn(),
      getStockMovements: vi.fn(),
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
          sku: 'SKU-TEE-1',
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
      expect(res[0].sku).toBe('SKU-TEE-1');
    });
  });
});

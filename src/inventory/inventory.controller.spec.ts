import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';

describe('InventoryController', () => {
  let controller: InventoryController;
  let service: {
    adjustStock: ReturnType<typeof vi.fn>;
    getStockMovements: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    service = {
      adjustStock: vi.fn(),
      getStockMovements: vi.fn(),
    };
    controller = new InventoryController(
      service as unknown as InventoryService,
    );
  });

  it('should adjust stock', async () => {
    service.adjustStock.mockResolvedValueOnce({
      stock: 20,
      movement: { id: 'mov-1', qtyChange: 10 },
    });

    const res = await controller.adjustStock('0190a8b0-0000-7000-8000-000000000001', {
      delta: 10,
    });
    expect(service.adjustStock).toHaveBeenCalledWith(
      '0190a8b0-0000-7000-8000-000000000001',
      { delta: 10 },
    );
    expect(res.stock).toBe(20);
  });

  it('should get stock movements', async () => {
    service.getStockMovements.mockResolvedValueOnce({
      data: [{ id: 'mov-1' }],
      nextCursor: null,
    });

    const res = await controller.getStockMovements(
      '0190a8b0-0000-7000-8000-000000000001',
      { limit: 10 },
    );
    expect(service.getStockMovements).toHaveBeenCalledWith(
      '0190a8b0-0000-7000-8000-000000000001',
      { limit: 10 },
    );
    expect(res.data.length).toBe(1);
  });
});

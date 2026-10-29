import { Injectable } from '@nestjs/common';
import type { AdjustStockDto } from './dto/adjust-stock.dto.js';
import type { StockMovementQueryDto } from './dto/stock-movement-query.dto.js';
import { InventoryRepository } from './inventory.repository.js';
import type {
  CatalogProductSnapshot,
  StockLevel,
  StockMovement,
} from './inventory.types.js';

@Injectable()
export class InventoryService {
  constructor(private readonly inventoryRepo: InventoryRepository) {}

  async getStock(
    productId: string,
    variantId?: string | null,
  ): Promise<StockLevel | null> {
    return this.inventoryRepo.getStock(productId, variantId);
  }

  async adjustStock(
    productId: string,
    dto: AdjustStockDto,
  ): Promise<{ stock: number; movement: StockMovement }> {
    return this.inventoryRepo.adjustStock(
      productId,
      dto.variantId,
      dto.delta,
      dto.reason ?? 'admin_adjustment',
    );
  }

  async getStockMovements(
    productId: string,
    query: StockMovementQueryDto,
  ): Promise<{ data: StockMovement[]; nextCursor: string | null }> {
    return this.inventoryRepo.getStockMovements(
      productId,
      query.cursor,
      query.limit ?? 20,
    );
  }

  async getProductSnapshots(ids: string[]): Promise<CatalogProductSnapshot[]> {
    if (!ids || ids.length === 0) return [];
    return this.inventoryRepo.getProductSnapshots(ids);
  }
}

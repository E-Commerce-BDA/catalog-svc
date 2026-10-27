import { BadRequestException, Injectable } from '@nestjs/common';
import type { AdjustStockDto } from './dto/adjust-stock.dto.js';
import type { ReleaseStockDto } from './dto/release-stock.dto.js';
import type { ReserveStockDto } from './dto/reserve-stock.dto.js';
import type { StockMovementQueryDto } from './dto/stock-movement-query.dto.js';
import { InventoryRepository } from './inventory.repository.js';
import type {
  CatalogProductSnapshot,
  StockLevel,
  StockMovement,
  StockReleaseResult,
  StockReservationResult,
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

  async reserveStock(dto: ReserveStockDto): Promise<StockReservationResult> {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('At least one item must be reserved');
    }
    return this.inventoryRepo.reserveStock(dto.items, dto.orderId);
  }

  async releaseStock(dto: ReleaseStockDto): Promise<StockReleaseResult> {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('At least one item must be released');
    }
    return this.inventoryRepo.releaseStock(dto.items, dto.orderId);
  }

  async getProductSnapshots(ids: string[]): Promise<CatalogProductSnapshot[]> {
    if (!ids || ids.length === 0) return [];
    return this.inventoryRepo.getProductSnapshots(ids);
  }
}

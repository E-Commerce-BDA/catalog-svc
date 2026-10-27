import { IsIn, IsInt, IsOptional, IsUUID } from 'class-validator';
import type { StockMovementReason } from '../inventory.types.js';

export class AdjustStockDto {
  @IsInt()
  delta!: number;

  @IsOptional()
  @IsUUID()
  variantId?: string | null;

  @IsOptional()
  @IsIn([
    'sale',
    'restock',
    'import',
    'admin_adjustment',
    'return',
    'cancel',
  ])
  reason?: StockMovementReason = 'admin_adjustment';
}

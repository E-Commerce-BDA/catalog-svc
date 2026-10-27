import { IsOptional, IsUUID } from 'class-validator';

export class StockQueryDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;
}

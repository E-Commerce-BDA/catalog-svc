import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class StockReservationItemDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsUUID()
  variantId?: string | null;

  @IsInt()
  @Min(1)
  quantity!: number;
}

export class ReserveStockDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StockReservationItemDto)
  items!: StockReservationItemDto[];

  @IsOptional()
  @IsUUID()
  orderId?: string;
}

import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { StockReservationItemDto } from './reserve-stock.dto.js';

export class ReleaseStockDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StockReservationItemDto)
  items!: StockReservationItemDto[];

  @IsOptional()
  @IsUUID()
  orderId?: string;
}

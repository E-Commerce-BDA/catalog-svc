import { IsOptional, IsUUID } from 'class-validator';

export class CommitStockDto {
  @IsUUID()
  reservationId!: string;

  /** Attached to the reservation on commit so it can be traced back to the order. */
  @IsOptional()
  @IsUUID()
  orderId?: string;
}

import { IsUUID } from 'class-validator';

/**
 * Release takes the reservation id only. The items to restore come from the
 * stored reservation, so a caller cannot inflate stock by asking for a
 * different quantity than it reserved.
 */
export class ReleaseStockDto {
  @IsUUID()
  reservationId!: string;
}

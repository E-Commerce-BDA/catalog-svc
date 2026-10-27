import {
  IsDateString,
  IsIn,
  IsNumber,
  Min,
} from 'class-validator';

export class CreateDiscountDto {
  @IsIn(['percent', 'fixed'])
  discountType!: 'percent' | 'fixed';

  @IsNumber()
  @Min(0)
  value!: number;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;
}

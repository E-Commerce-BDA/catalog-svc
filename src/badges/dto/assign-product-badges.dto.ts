import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class ProductBadgeAssignmentItemDto {
  @IsUUID()
  badgeId!: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @IsOptional()
  @IsDateString()
  endsAt?: string | null;
}

export class AssignProductBadgesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductBadgeAssignmentItemDto)
  badges!: ProductBadgeAssignmentItemDto[];
}

import { IsOptional, IsString } from 'class-validator';

export class BrandQueryDto {
  @IsOptional()
  @IsString()
  includeInactive?: string;
}

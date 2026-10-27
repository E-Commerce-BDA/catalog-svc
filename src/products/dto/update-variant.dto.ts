import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateVariantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

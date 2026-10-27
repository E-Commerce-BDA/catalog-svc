import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class VariantOptionSelectionDto {
  @IsUUID('all')
  optionId!: string;

  @IsUUID('all')
  optionValueId!: string;
}

export class CreateVariantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @IsNumber()
  @Min(0)
  price!: number;

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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantOptionSelectionDto)
  options?: VariantOptionSelectionDto[];
}

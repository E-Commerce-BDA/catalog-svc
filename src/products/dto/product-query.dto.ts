import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ProductQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsUUID('all')
  categoryId?: string;

  @IsOptional()
  @IsUUID('all')
  brandId?: string;

  @IsOptional()
  @IsIn(['draft', 'active', 'archived'])
  status?: 'draft' | 'active' | 'archived';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'created_desc', 'name_asc'])
  sort?: 'price_asc' | 'price_desc' | 'created_desc' | 'name_asc';

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  includeInactive?: string;

  /**
   * Manual curation support (CMS `featured_products source:"manual"`): an
   * explicit id list, `?ids=a,b` or repeated `?ids=a&ids=b`, max 24. When
   * present the result follows the submitted order unless `sort` overrides
   * it, and non-active ids simply never appear — the status floor stays.
   */
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((v) => String(v).trim())
      : String(value)
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
  )
  @IsUUID('all', { each: true })
  @ArrayMaxSize(24)
  ids?: string[];
}

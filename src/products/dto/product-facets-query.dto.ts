import { IsOptional, IsUUID } from 'class-validator';

/** Optional narrowing for the listing facet rail. */
export class ProductFacetsQueryDto {
  @IsOptional()
  @IsUUID('all')
  categoryId?: string;

  @IsOptional()
  @IsUUID('all')
  brandId?: string;
}

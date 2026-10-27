import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  slug?: string;

  @IsOptional()
  @IsUUID('all')
  parentId?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  showInNavbar?: boolean;

  @IsOptional()
  @IsBoolean()
  showInMegamenu?: boolean;

  @IsOptional()
  @IsBoolean()
  megamenuShowImages?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

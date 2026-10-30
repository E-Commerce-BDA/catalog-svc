import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateOptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  values!: Array<
    | string
    | {
        value: string;
        swatchHex?: string | null;
        swatchImageUrl?: string | null;
      }
  >;

  @IsOptional()
  @IsIn(['text', 'pill', 'swatch'])
  displayType?: 'text' | 'pill' | 'swatch';

  @IsOptional()
  @IsBoolean()
  showOnCard?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class UpdateOptionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsIn(['text', 'pill', 'swatch'])
  displayType?: 'text' | 'pill' | 'swatch';

  @IsOptional()
  @IsBoolean()
  showOnCard?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}


import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateBadgeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  label!: string;

  @IsString()
  @Matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
    message: 'bg must be a hex color',
  })
  bg!: string;

  @IsString()
  @Matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
    message: 'textColor must be a hex color',
  })
  textColor!: string;

  @IsOptional()
  @IsString()
  @Matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
    message: 'borderColor must be a hex color',
  })
  borderColor?: string | null;

  @IsOptional()
  @IsIn(['solid', 'dashed', 'dotted'])
  borderStyle?: 'solid' | 'dashed' | 'dotted';

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

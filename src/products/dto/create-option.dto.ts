import {
  ArrayMinSize,
  IsArray,
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
  @IsString({ each: true })
  values!: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

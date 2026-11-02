import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import { VariantOptionSelectionDto } from './create-variant.dto.js';

export class SetVariantOptionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantOptionSelectionDto)
  options!: VariantOptionSelectionDto[];
}

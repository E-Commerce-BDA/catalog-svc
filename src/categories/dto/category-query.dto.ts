import { IsOptional, IsString } from 'class-validator';

export class CategoryQueryDto {
  @IsOptional()
  @IsString()
  navbar?: string;

  @IsOptional()
  @IsString()
  tree?: string;

  @IsOptional()
  @IsString()
  includeInactive?: string;
}

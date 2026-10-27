import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { BrandsService } from './brands.service.js';
import { Brand } from './brands.types.js';
import { BrandQueryDto } from './dto/brand-query.dto.js';
import { CreateBrandDto } from './dto/create-brand.dto.js';
import { UpdateBrandDto } from './dto/update-brand.dto.js';

@Controller(['catalog/brands', 'brands'])
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  async getBrands(@Query() query: BrandQueryDto): Promise<{ data: Brand[] }> {
    const brands = await this.brandsService.getBrands(query);
    return { data: brands };
  }

  @Get(':slug')
  @Header('Cache-Control', 'public, max-age=60')
  async getBrandBySlug(@Param('slug') slug: string): Promise<{ brand: Brand }> {
    const brand = await this.brandsService.getBrandBySlug(slug);
    return { brand };
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async createBrand(@Body() dto: CreateBrandDto): Promise<{ brand: Brand }> {
    const brand = await this.brandsService.createBrand(dto);
    return { brand };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async updateBrand(
    @Param('id') id: string,
    @Body() dto: UpdateBrandDto,
  ): Promise<{ brand: Brand }> {
    const brand = await this.brandsService.updateBrand(id, dto);
    return { brand };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBrand(@Param('id') id: string): Promise<void> {
    await this.brandsService.deleteBrand(id);
  }
}

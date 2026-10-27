import {
  Body,
  Controller,
  Delete,
  Get,
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
import { CreateDiscountDto } from './dto/create-discount.dto.js';
import { CreateImageDto } from './dto/create-image.dto.js';
import { CreateOptionDto } from './dto/create-option.dto.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { CreateVariantDto } from './dto/create-variant.dto.js';
import { ProductQueryDto } from './dto/product-query.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { ProductsService } from './products.service.js';
import {
  ProductDetail,
  ProductDiscount,
  ProductImage,
  ProductListItem,
  ProductOption,
  ProductVariant,
} from './products.types.js';

@Controller(['catalog/products', 'products'])
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  async getProducts(
    @Query() query: ProductQueryDto,
  ): Promise<{ data: ProductListItem[]; nextCursor: string | null }> {
    return this.productsService.getProducts(query);
  }

  @Get('id/:id')
  async getProductById(
    @Param('id') id: string,
  ): Promise<{ product: ProductDetail }> {
    const product = await this.productsService.getProductById(id);
    return { product };
  }

  @Get(':slug')
  async getProductBySlug(
    @Param('slug') slug: string,
  ): Promise<{ product: ProductDetail }> {
    const product = await this.productsService.getProductBySlug(slug);
    return { product };
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async createProduct(
    @Body() dto: CreateProductDto,
  ): Promise<{ product: ProductDetail }> {
    const product = await this.productsService.createProduct(dto);
    return { product };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async updateProduct(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<{ product: ProductDetail }> {
    const product = await this.productsService.updateProduct(id, dto);
    return { product };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteProduct(@Param('id') id: string): Promise<void> {
    await this.productsService.deleteProduct(id);
  }

  // --- Sub-resources posted under product id ---
  @Post(':id/variants')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async createVariant(
    @Param('id') id: string,
    @Body() dto: CreateVariantDto,
  ): Promise<{ variant: ProductVariant }> {
    const variant = await this.productsService.createVariant(id, dto);
    return { variant };
  }

  @Post(':id/options')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async createOption(
    @Param('id') id: string,
    @Body() dto: CreateOptionDto,
  ): Promise<{ option: ProductOption }> {
    const option = await this.productsService.createOption(id, dto);
    return { option };
  }

  @Post(':id/images')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async createImage(
    @Param('id') id: string,
    @Body() dto: CreateImageDto,
  ): Promise<{ image: ProductImage }> {
    const image = await this.productsService.createImage(id, dto);
    return { image };
  }

  @Post(':id/discounts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async createDiscount(
    @Param('id') id: string,
    @Body() dto: CreateDiscountDto,
  ): Promise<{ discount: ProductDiscount }> {
    const discount = await this.productsService.createDiscount(id, dto);
    return { discount };
  }
}

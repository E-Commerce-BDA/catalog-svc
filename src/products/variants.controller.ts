import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { UpdateVariantDto } from './dto/update-variant.dto.js';
import { ProductsService } from './products.service.js';
import { ProductVariant } from './products.types.js';

@Controller(['catalog/variants', 'variants'])
export class VariantsController {
  constructor(private readonly productsService: ProductsService) {}

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async updateVariant(
    @Param('id') id: string,
    @Body() dto: UpdateVariantDto,
  ): Promise<{ variant: ProductVariant }> {
    const variant = await this.productsService.updateVariant(id, dto);
    return { variant };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteVariant(@Param('id') id: string): Promise<void> {
    await this.productsService.deleteVariant(id);
  }
}

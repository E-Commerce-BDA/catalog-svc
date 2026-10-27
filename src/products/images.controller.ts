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
import { UpdateImageDto } from './dto/update-image.dto.js';
import { ProductsService } from './products.service.js';
import { ProductImage } from './products.types.js';

@Controller(['catalog/images', 'images'])
export class ImagesController {
  constructor(private readonly productsService: ProductsService) {}

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async updateImage(
    @Param('id') id: string,
    @Body() dto: UpdateImageDto,
  ): Promise<{ image: ProductImage }> {
    const image = await this.productsService.updateImage(id, dto);
    return { image };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteImage(@Param('id') id: string): Promise<void> {
    await this.productsService.deleteImage(id);
  }
}

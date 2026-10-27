import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { ProductsService } from './products.service.js';

@Controller(['catalog/discounts', 'discounts'])
export class DiscountsController {
  constructor(private readonly productsService: ProductsService) {}

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDiscount(@Param('id') id: string): Promise<void> {
    await this.productsService.deleteDiscount(id);
  }
}

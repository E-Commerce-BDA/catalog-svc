import { Module } from '@nestjs/common';
import { DiscountsController } from './discounts.controller.js';
import { ImagesController } from './images.controller.js';
import { ProductsController } from './products.controller.js';
import { ProductsRepository } from './products.repository.js';
import { ProductsService } from './products.service.js';
import { VariantsController } from './variants.controller.js';

@Module({
  controllers: [
    ProductsController,
    VariantsController,
    ImagesController,
    DiscountsController,
  ],
  providers: [ProductsService, ProductsRepository],
  exports: [ProductsService, ProductsRepository],
})
export class ProductsModule {}

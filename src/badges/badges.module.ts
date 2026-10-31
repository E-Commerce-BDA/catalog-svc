import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module.js';
import {
  BadgesController,
  ProductBadgesController,
} from './badges.controller.js';
import { BadgesRepository } from './badges.repository.js';
import { BadgesService } from './badges.service.js';

@Module({
  // `ProductsModule` supplies the repository used to rebuild the
  // `product.updated` payload after a badge assignment.
  imports: [ProductsModule],
  controllers: [BadgesController, ProductBadgesController],
  providers: [BadgesService, BadgesRepository],
  exports: [BadgesService, BadgesRepository],
})
export class BadgesModule {}

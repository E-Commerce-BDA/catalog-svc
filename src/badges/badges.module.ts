import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { ProductsModule } from '../products/products.module.js';
import {
  BadgesController,
  ProductBadgesController,
} from './badges.controller.js';
import { BadgesRepository } from './badges.repository.js';
import { BadgesService } from './badges.service.js';

@Module({
  imports: [EventsModule, ProductsModule],
  controllers: [BadgesController, ProductBadgesController],
  providers: [BadgesService, BadgesRepository],
  exports: [BadgesService, BadgesRepository],
})
export class BadgesModule {}

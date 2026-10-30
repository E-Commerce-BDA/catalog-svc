import { Module } from '@nestjs/common';
import {
  BadgesController,
  ProductBadgesController,
} from './badges.controller.js';
import { BadgesRepository } from './badges.repository.js';
import { BadgesService } from './badges.service.js';

@Module({
  controllers: [BadgesController, ProductBadgesController],
  providers: [BadgesService, BadgesRepository],
  exports: [BadgesService, BadgesRepository],
})
export class BadgesModule {}

import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller.js';
import { InventoryRepository } from './inventory.repository.js';
import { InventoryService } from './inventory.service.js';

@Module({
  controllers: [InventoryController],
  providers: [InventoryRepository, InventoryService],
  exports: [InventoryRepository, InventoryService],
})
export class InventoryModule {}

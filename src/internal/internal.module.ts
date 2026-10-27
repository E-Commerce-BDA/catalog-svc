import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { InternalController } from './internal.controller.js';

@Module({
  imports: [InventoryModule],
  controllers: [InternalController],
})
export class InternalModule {}

import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { StockModule } from '../stock/stock.module.js';
import { InternalController } from './internal.controller.js';

@Module({
  imports: [InventoryModule, StockModule],
  controllers: [InternalController],
})
export class InternalModule {}

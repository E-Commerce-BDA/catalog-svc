import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { AdjustStockDto } from './dto/adjust-stock.dto.js';
import { StockMovementQueryDto } from './dto/stock-movement-query.dto.js';
import { InventoryService } from './inventory.service.js';
import type { StockMovement } from './inventory.types.js';

@Controller(['catalog/products', 'products'])
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post(':id/stock')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Header('Cache-Control', 'no-store')
  async adjustStock(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AdjustStockDto,
  ): Promise<{ stock: number; movement: StockMovement }> {
    return this.inventoryService.adjustStock(id, dto);
  }

  @Get(':id/stock-movements')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Header('Cache-Control', 'no-store')
  async getStockMovements(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: StockMovementQueryDto,
  ): Promise<{ data: StockMovement[]; nextCursor: string | null }> {
    return this.inventoryService.getStockMovements(id, query);
  }
}

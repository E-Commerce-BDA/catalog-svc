import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServiceKeyGuard } from '../auth/guards/service-key.guard.js';
import { ReleaseStockDto } from '../inventory/dto/release-stock.dto.js';
import { ReserveStockDto } from '../inventory/dto/reserve-stock.dto.js';
import { StockQueryDto } from '../inventory/dto/stock-query.dto.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type {
  CatalogProductSnapshot,
  StockLevel,
  StockReleaseResult,
  StockReservationResult,
} from '../inventory/inventory.types.js';

@Controller(['catalog/internal', 'internal'])
@UseGuards(ServiceKeyGuard)
export class InternalController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('stock')
  async getStock(@Query() query: StockQueryDto): Promise<StockLevel> {
    const stockLevel = await this.inventoryService.getStock(
      query.productId,
      query.variantId,
    );
    if (!stockLevel) {
      throw new NotFoundException(
        `Stock not found for product ${query.productId}${
          query.variantId ? ` (variant ${query.variantId})` : ''
        }`,
      );
    }
    return stockLevel;
  }

  @Post('stock/reserve')
  async reserveStock(
    @Body() dto: ReserveStockDto,
  ): Promise<StockReservationResult> {
    return this.inventoryService.reserveStock(dto);
  }

  @Post('stock/release')
  async releaseStock(
    @Body() dto: ReleaseStockDto,
  ): Promise<StockReleaseResult> {
    return this.inventoryService.releaseStock(dto);
  }

  @Get('products')
  async getProducts(
    @Query('ids') idsParam?: string,
  ): Promise<{ data: CatalogProductSnapshot[] }> {
    if (!idsParam) {
      return { data: [] };
    }

    const ids = idsParam
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const id of ids) {
      if (!uuidRegex.test(id)) {
        throw new BadRequestException(`Invalid UUID in ids query: ${id}`);
      }
    }

    const data = await this.inventoryService.getProductSnapshots(ids);
    return { data };
  }
}

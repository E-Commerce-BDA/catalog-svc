import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServiceKeyGuard } from '../auth/guards/service-key.guard.js';
import { StockQueryDto } from '../inventory/dto/stock-query.dto.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type {
  CatalogProductSnapshot,
  StockLevel,
} from '../inventory/inventory.types.js';
import { CommitStockDto } from '../stock/dto/commit-stock.dto.js';
import { ReleaseStockDto } from '../stock/dto/release-stock.dto.js';
import { ReserveStockDto } from '../stock/dto/reserve-stock.dto.js';
import { StockReservationsService } from '../stock/stock-reservations.service.js';
import type {
  StockCommitResult,
  StockReleaseResult,
  StockReservationResult,
  StockReservationView,
} from '../stock/stock.types.js';

@Controller(['catalog/internal', 'internal'])
@UseGuards(ServiceKeyGuard)
export class InternalController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly stockReservations: StockReservationsService,
  ) {}

  @Get('stock')
  @Header('Cache-Control', 'no-store')
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
  @Header('Cache-Control', 'no-store')
  async reserveStock(
    @Body() dto: ReserveStockDto,
  ): Promise<StockReservationResult> {
    return this.stockReservations.reserve(dto);
  }

  @Post('stock/release')
  @Header('Cache-Control', 'no-store')
  async releaseStock(
    @Body() dto: ReleaseStockDto,
  ): Promise<StockReleaseResult> {
    return this.stockReservations.release(dto);
  }

  @Post('stock/commit')
  @Header('Cache-Control', 'no-store')
  async commitStock(@Body() dto: CommitStockDto): Promise<StockCommitResult> {
    return this.stockReservations.commit(dto);
  }

  @Get('stock/reservations/:id')
  @Header('Cache-Control', 'no-store')
  async getReservation(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StockReservationView> {
    return this.stockReservations.getReservation(id);
  }

  @Get('products')
  @Header('Cache-Control', 'no-store')
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

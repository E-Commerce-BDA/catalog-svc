import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { BadgesService } from './badges.service.js';
import { Badge, ProductBadgeItem } from './badges.types.js';
import { AssignProductBadgesDto } from './dto/assign-product-badges.dto.js';
import { CreateBadgeDto } from './dto/create-badge.dto.js';
import { UpdateBadgeDto } from './dto/update-badge.dto.js';

@Controller(['catalog/badges', 'badges'])
export class BadgesController {
  constructor(private readonly badgesService: BadgesService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  async getBadges(
    @Query('activeOnly') activeOnly?: string,
  ): Promise<{ data: Badge[] }> {
    const isOnlyActive = activeOnly === 'true' || activeOnly === undefined;
    const badges = await this.badgesService.getBadges({ activeOnly: isOnlyActive });
    return { data: badges };
  }

  @Get(':id')
  @Header('Cache-Control', 'public, max-age=60')
  async getBadgeById(@Param('id') id: string): Promise<{ badge: Badge }> {
    const badge = await this.badgesService.getBadgeById(id);
    return { badge };
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async createBadge(@Body() dto: CreateBadgeDto): Promise<{ badge: Badge }> {
    const badge = await this.badgesService.createBadge(dto);
    return { badge };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async updateBadge(
    @Param('id') id: string,
    @Body() dto: UpdateBadgeDto,
  ): Promise<{ badge: Badge }> {
    const badge = await this.badgesService.updateBadge(id, dto);
    return { badge };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBadge(@Param('id') id: string): Promise<void> {
    await this.badgesService.deleteBadge(id);
  }
}

@Controller(['catalog/products/:id/badges', 'products/:id/badges'])
export class ProductBadgesController {
  constructor(private readonly badgesService: BadgesService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  async getProductBadges(
    @Param('id') productId: string,
  ): Promise<{ badges: ProductBadgeItem[] }> {
    const badges = await this.badgesService.getProductBadges(productId);
    return { badges };
  }

  @Put()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async assignProductBadges(
    @Param('id') productId: string,
    @Body() dto: AssignProductBadgesDto,
  ): Promise<{ badges: ProductBadgeItem[] }> {
    const badges = await this.badgesService.assignProductBadges(productId, dto);
    return { badges };
  }
}

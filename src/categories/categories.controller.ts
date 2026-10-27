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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CategoriesService } from './categories.service.js';
import {
  Category,
  CategoryTreeItem,
} from './categories.types.js';
import { CategoryQueryDto } from './dto/category-query.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

@Controller(['catalog/categories', 'categories'])
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  async getCategories(
    @Query() query: CategoryQueryDto,
  ): Promise<{ data: Category[] | CategoryTreeItem[] }> {
    const categories = await this.categoriesService.getCategories(query);
    return { data: categories };
  }

  @Get('navbar')
  @Header(
    'Cache-Control',
    'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
  )
  async getNavbarCategories(): Promise<{ data: Category[] }> {
    const categories = await this.categoriesService.getCategories({
      navbar: 'true',
    });
    return { data: categories as Category[] };
  }

  @Get('tree')
  @Header('Cache-Control', 'public, max-age=60')
  async getCategoryTree(): Promise<{ data: CategoryTreeItem[] }> {
    const tree = await this.categoriesService.getCategoryTree();
    return { data: tree };
  }

  @Get(':slug')
  @Header('Cache-Control', 'public, max-age=60')
  async getCategoryBySlug(
    @Param('slug') slug: string,
  ): Promise<{ category: Category }> {
    const category = await this.categoriesService.getCategoryBySlug(slug);
    return { category };
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async createCategory(
    @Body() dto: CreateCategoryDto,
  ): Promise<{ category: Category }> {
    const category = await this.categoriesService.createCategory(dto);
    return { category };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async updateCategory(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<{ category: Category }> {
    const category = await this.categoriesService.updateCategory(id, dto);
    return { category };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCategory(@Param('id') id: string): Promise<void> {
    await this.categoriesService.deleteCategory(id);
  }
}

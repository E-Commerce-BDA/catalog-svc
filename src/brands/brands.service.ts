import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { slugify } from '../categories/categories.service.js';
import { BrandsRepository } from './brands.repository.js';
import { Brand } from './brands.types.js';
import { BrandQueryDto } from './dto/brand-query.dto.js';
import { CreateBrandDto } from './dto/create-brand.dto.js';
import { UpdateBrandDto } from './dto/update-brand.dto.js';

@Injectable()
export class BrandsService {
  constructor(private readonly repository: BrandsRepository) {}

  async getBrands(query: BrandQueryDto = {}): Promise<Brand[]> {
    const activeOnly = query.includeInactive !== 'true';
    return this.repository.findAll({ activeOnly });
  }

  async getBrandBySlug(slug: string): Promise<Brand> {
    const brand = await this.repository.findBySlug(slug);
    if (!brand) {
      throw new NotFoundException(`Brand with slug '${slug}' not found`);
    }
    return brand;
  }

  async createBrand(dto: CreateBrandDto): Promise<Brand> {
    const slug = dto.slug && dto.slug.trim().length > 0 ? slugify(dto.slug) : slugify(dto.name);

    if (!slug) {
      throw new BadRequestException('A valid brand name or slug is required');
    }

    const existing = await this.repository.findBySlug(slug);
    if (existing) {
      throw new ConflictException(`Brand with slug '${slug}' already exists`);
    }

    try {
      return await this.repository.create({
        name: dto.name,
        slug,
        logoUrl: dto.logoUrl,
        description: dto.description,
        isActive: dto.isActive,
        sortOrder: dto.sortOrder,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique constraint')) {
        throw new ConflictException(`Brand with slug '${slug}' already exists`);
      }
      throw err;
    }
  }

  async updateBrand(id: string, dto: UpdateBrandDto): Promise<Brand> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Brand with id '${id}' not found`);
    }

    let slug = dto.slug;
    if (slug) {
      slug = slugify(slug);
      const duplicate = await this.repository.findBySlug(slug);
      if (duplicate && duplicate.id !== id) {
        throw new ConflictException(`Brand with slug '${slug}' already exists`);
      }
    }

    const updated = await this.repository.update(id, {
      name: dto.name,
      slug: slug ?? dto.slug,
      logoUrl: dto.logoUrl,
      description: dto.description,
      isActive: dto.isActive,
      sortOrder: dto.sortOrder,
    });

    if (!updated) {
      throw new NotFoundException(`Brand with id '${id}' not found`);
    }

    return updated;
  }

  async deleteBrand(id: string): Promise<void> {
    const deleted = await this.repository.softDelete(id);
    if (!deleted) {
      throw new NotFoundException(`Brand with id '${id}' not found`);
    }
  }
}

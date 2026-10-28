import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { slugify } from '../categories/categories.service.js';
import { EventsService } from '../events/events.service.js';
import { CreateDiscountDto } from './dto/create-discount.dto.js';
import { CreateImageDto } from './dto/create-image.dto.js';
import { CreateOptionDto } from './dto/create-option.dto.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { CreateVariantDto } from './dto/create-variant.dto.js';
import { ProductQueryDto } from './dto/product-query.dto.js';
import { UpdateImageDto } from './dto/update-image.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { UpdateVariantDto } from './dto/update-variant.dto.js';
import { ProductsRepository } from './products.repository.js';
import {
  ProductDetail,
  ProductDiscount,
  ProductImage,
  ProductListItem,
  ProductOption,
  ProductVariant,
} from './products.types.js';

@Injectable()
export class ProductsService {
  constructor(
    private readonly repository: ProductsRepository,
    private readonly eventsService: EventsService,
  ) {}

  async getProducts(
    query: ProductQueryDto = {},
  ): Promise<{ data: ProductListItem[]; nextCursor: string | null }> {
    return this.repository.findList(query);
  }

  async getProductBySlug(slug: string): Promise<ProductDetail> {
    const detail = await this.repository.findDetail({ slug });
    if (!detail) {
      throw new NotFoundException(`Product with slug '${slug}' not found`);
    }
    return detail;
  }

  async getProductById(id: string): Promise<ProductDetail> {
    const detail = await this.repository.findDetail({ id });
    if (!detail) {
      throw new NotFoundException(`Product with id '${id}' not found`);
    }
    return detail;
  }

  async createProduct(dto: CreateProductDto): Promise<ProductDetail> {
    const slug =
      dto.slug && dto.slug.trim().length > 0 ? slugify(dto.slug) : slugify(dto.name);

    if (!slug) {
      throw new BadRequestException('A valid product name or slug is required');
    }

    const [existingSku, existingSlug] = await Promise.all([
      this.repository.findBySku(dto.sku),
      this.repository.findBySlug(slug),
    ]);

    if (existingSku) {
      throw new ConflictException(`Product with SKU '${dto.sku}' already exists`);
    }
    if (existingSlug) {
      throw new ConflictException(`Product with slug '${slug}' already exists`);
    }

    try {
      const created = await this.repository.create({
        sku: dto.sku,
        name: dto.name,
        slug,
        shortDescription: dto.shortDescription,
        description: dto.description,
        categoryId: dto.categoryId,
        brandId: dto.brandId,
        price: dto.price,
        compareAtPrice: dto.compareAtPrice,
        stock: dto.stock,
        status: dto.status,
        tags: dto.tags,
        attributes: dto.attributes,
        photoSettings: dto.photoSettings,
        source: dto.source,
        externalId: dto.externalId,
        weightG: dto.weightG,
      });

      await this.eventsService.publishProductUpdated({
        productId: created.id,
        sku: created.sku,
        name: created.name,
        slug: created.slug,
        description: created.description ?? undefined,
        categoryId: created.category?.id ?? undefined,
        categorySlug: created.category?.slug ?? undefined,
        brandId: created.brand?.id ?? undefined,
        brandName: created.brand?.name ?? undefined,
        price: created.price,
        stock: created.stock,
        imageUrl: created.images?.[0]?.url,
        status: created.status === 'active' ? 'active' : 'inactive',
        updatedAt: created.updatedAt,
      });

      return created;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique constraint')) {
        throw new ConflictException('Product SKU or slug conflict');
      }
      throw err;
    }
  }

  async updateProduct(id: string, dto: UpdateProductDto): Promise<ProductDetail> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Product with id '${id}' not found`);
    }

    if (dto.sku && dto.sku !== existing.sku) {
      const duplicateSku = await this.repository.findBySku(dto.sku);
      if (duplicateSku && duplicateSku.id !== id) {
        throw new ConflictException(`Product with SKU '${dto.sku}' already exists`);
      }
    }

    let slug = dto.slug;
    if (slug) {
      slug = slugify(slug);
      const duplicateSlug = await this.repository.findBySlug(slug);
      if (duplicateSlug && duplicateSlug.id !== id) {
        throw new ConflictException(`Product with slug '${slug}' already exists`);
      }
    }

    const updated = await this.repository.update(id, {
      sku: dto.sku,
      name: dto.name,
      slug: slug ?? dto.slug,
      shortDescription: dto.shortDescription,
      description: dto.description,
      categoryId: dto.categoryId,
      brandId: dto.brandId,
      price: dto.price,
      compareAtPrice: dto.compareAtPrice,
      stock: dto.stock,
      status: dto.status,
      tags: dto.tags,
      attributes: dto.attributes,
      photoSettings: dto.photoSettings,
      weightG: dto.weightG,
    });

    if (!updated) {
      throw new NotFoundException(`Product with id '${id}' not found`);
    }

    await this.eventsService.publishProductUpdated({
      productId: updated.id,
      sku: updated.sku,
      name: updated.name,
      slug: updated.slug,
      description: updated.description ?? undefined,
      categoryId: updated.category?.id ?? undefined,
      categorySlug: updated.category?.slug ?? undefined,
      brandId: updated.brand?.id ?? undefined,
      brandName: updated.brand?.name ?? undefined,
      price: updated.price,
      stock: updated.stock,
      imageUrl: updated.images?.[0]?.url,
      status: updated.status === 'active' ? 'active' : 'inactive',
      updatedAt: updated.updatedAt,
    });

    return updated;
  }

  async deleteProduct(id: string): Promise<void> {
    const existing = await this.repository.findById(id);
    const deleted = await this.repository.softDelete(id);
    if (!deleted) {
      throw new NotFoundException(`Product with id '${id}' not found`);
    }

    if (existing) {
      await this.eventsService.publishProductUpdated({
        productId: existing.id,
        sku: existing.sku,
        name: existing.name,
        slug: existing.slug,
        price: existing.price,
        status: 'inactive',
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // --- Variants ---
  async createVariant(
    productId: string,
    dto: CreateVariantDto,
  ): Promise<ProductVariant> {
    const product = await this.repository.findById(productId);
    if (!product) {
      throw new NotFoundException(`Product with id '${productId}' not found`);
    }

    try {
      return await this.repository.createVariant(productId, dto);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique constraint')) {
        throw new ConflictException(`Variant with SKU '${dto.sku}' already exists`);
      }
      throw err;
    }
  }

  async updateVariant(
    id: string,
    dto: UpdateVariantDto,
  ): Promise<ProductVariant> {
    const variant = await this.repository.findVariantById(id);
    if (!variant) {
      throw new NotFoundException(`Variant with id '${id}' not found`);
    }

    const updated = await this.repository.updateVariant(id, dto);
    if (!updated) {
      throw new NotFoundException(`Variant with id '${id}' not found`);
    }
    return updated;
  }

  async deleteVariant(id: string): Promise<void> {
    const deleted = await this.repository.deleteVariant(id);
    if (!deleted) {
      throw new NotFoundException(`Variant with id '${id}' not found`);
    }
  }

  // --- Options ---
  async createOption(
    productId: string,
    dto: CreateOptionDto,
  ): Promise<ProductOption> {
    const product = await this.repository.findById(productId);
    if (!product) {
      throw new NotFoundException(`Product with id '${productId}' not found`);
    }

    return this.repository.createOption(productId, dto);
  }

  // --- Images ---
  async createImage(
    productId: string,
    dto: CreateImageDto,
  ): Promise<ProductImage> {
    const product = await this.repository.findById(productId);
    if (!product) {
      throw new NotFoundException(`Product with id '${productId}' not found`);
    }

    return this.repository.createImage(productId, dto);
  }

  async updateImage(id: string, dto: UpdateImageDto): Promise<ProductImage> {
    const updated = await this.repository.updateImage(id, dto);
    if (!updated) {
      throw new NotFoundException(`Image with id '${id}' not found`);
    }
    return updated;
  }

  async deleteImage(id: string): Promise<void> {
    const deleted = await this.repository.deleteImage(id);
    if (!deleted) {
      throw new NotFoundException(`Image with id '${id}' not found`);
    }
  }

  // --- Discounts ---
  async createDiscount(
    productId: string,
    dto: CreateDiscountDto,
  ): Promise<ProductDiscount> {
    const product = await this.repository.findById(productId);
    if (!product) {
      throw new NotFoundException(`Product with id '${productId}' not found`);
    }

    if (dto.discountType === 'percent' && dto.value > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100%');
    }

    return this.repository.createDiscount(productId, dto);
  }

  async deleteDiscount(id: string): Promise<void> {
    const deleted = await this.repository.deleteDiscount(id);
    if (!deleted) {
      throw new NotFoundException(`Discount with id '${id}' not found`);
    }
  }
}

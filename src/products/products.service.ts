import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { slugify } from '../categories/categories.service.js';
import { withTransaction, type QueryHandle } from '../db/tx.js';
import { CatalogOutbox } from '../outbox/catalog-outbox.js';
import { CursorValidationError } from './cursor.codec.js';
import { CreateDiscountDto } from './dto/create-discount.dto.js';
import { CreateImageDto } from './dto/create-image.dto.js';
import { CreateOptionDto, UpdateOptionDto } from './dto/create-option.dto.js';
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
  ProductFacets,
  ProductImage,
  ProductListItem,
  ProductOption,
  ProductVariant,
} from './products.types.js';

@Injectable()
export class ProductsService {
  constructor(
    private readonly repository: ProductsRepository,
    private readonly outbox: CatalogOutbox,
  ) {}

  async getProducts(
    query: ProductQueryDto = {},
  ): Promise<{ data: ProductListItem[]; nextCursor: string | null }> {
    try {
      return await this.repository.findList(query);
    } catch (error) {
      if (error instanceof CursorValidationError) {
        throw new BadRequestException({
          code: 'CURSOR_INVALID',
          message: error.message,
        });
      }
      throw error;
    }
  }

  async getFacets(filter: {
    categoryId?: string;
    brandId?: string;
  }): Promise<ProductFacets> {
    return this.repository.findFacets(filter);
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
      return await withTransaction(async (client) => {
        const created = await this.repository.create(
          {
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
            cardSettings: dto.cardSettings,
            source: dto.source,
            externalId: dto.externalId,
            weightG: dto.weightG,
          },
          client,
        );

        await this.outbox.recordProduct(client, created);
        return created;
      });
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

    return withTransaction(async (client) => {
      const updated = await this.repository.update(
        id,
        {
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
          cardSettings: dto.cardSettings,
          weightG: dto.weightG,
        },
        client,
      );

      if (!updated) {
        throw new NotFoundException(`Product with id '${id}' not found`);
      }

      // `update` re-reads the detail through the same client, so the payload
      // describes the row exactly as it is about to commit.
      await this.outbox.recordProduct(client, updated);
      return updated;
    });
  }

  async deleteProduct(id: string): Promise<void> {
    await withTransaction(async (client) => {
      const deleted = await this.repository.softDelete(id, client);
      if (!deleted) {
        throw new NotFoundException(`Product with id '${id}' not found`);
      }

      await this.outbox.recordProduct(client, deleted);
    });
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
      return await withTransaction(async (client) => {
        const variant = await this.repository.createVariant(
          productId,
          dto,
          client,
        );
        await this.recordProductUpdated(client, productId);
        return variant;
      });
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

    return withTransaction(async (client) => {
      const updated = await this.repository.updateVariant(id, dto, client);
      if (!updated) {
        throw new NotFoundException(`Variant with id '${id}' not found`);
      }
      await this.recordProductUpdated(client, updated.productId);
      return updated;
    });
  }

  async setVariantOptions(
    id: string,
    options: { optionId: string; optionValueId: string }[],
  ): Promise<ProductVariant> {
    const variant = await this.repository.findVariantById(id);
    if (!variant) {
      throw new NotFoundException(`Variant with id '${id}' not found`);
    }

    return withTransaction(async (client) => {
      await this.repository.setVariantOptions(id, options, client);
      await this.recordProductUpdated(client, variant.productId);
      const updated = await this.repository.findVariantById(id, client);
      return updated!;
    });
  }

  async deleteVariant(id: string): Promise<void> {
    await withTransaction(async (client) => {
      const productId = await this.repository.deleteVariant(id, client);
      if (!productId) {
        throw new NotFoundException(`Variant with id '${id}' not found`);
      }
      await this.recordProductUpdated(client, productId);
    });
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

    return withTransaction(async (client) => {
      const created = await this.repository.createOption(productId, dto, client);
      await this.recordProductUpdated(client, productId);
      return created;
    });
  }

  async updateOption(
    productId: string,
    optionId: string,
    dto: UpdateOptionDto,
  ): Promise<ProductOption> {
    const product = await this.repository.findById(productId);
    if (!product) {
      throw new NotFoundException(`Product with id '${productId}' not found`);
    }

    return withTransaction(async (client) => {
      const updated = await this.repository.updateOption(optionId, dto, client);
      if (!updated) {
        throw new NotFoundException(`Option with id '${optionId}' not found`);
      }
      await this.recordProductUpdated(client, productId);
      return updated;
    });
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

    return withTransaction(async (client) => {
      const created = await this.repository.createImage(productId, dto, client);
      await this.recordProductUpdated(client, productId);
      return created;
    });
  }

  async updateImage(id: string, dto: UpdateImageDto): Promise<ProductImage> {
    return withTransaction(async (client) => {
      const updated = await this.repository.updateImage(id, dto, client);
      if (!updated) {
        throw new NotFoundException(`Image with id '${id}' not found`);
      }
      await this.recordProductUpdated(client, updated.productId);
      return updated;
    });
  }

  async deleteImage(id: string): Promise<void> {
    await withTransaction(async (client) => {
      const productId = await this.repository.deleteImage(id, client);
      if (!productId) {
        throw new NotFoundException(`Image with id '${id}' not found`);
      }
      await this.recordProductUpdated(client, productId);
    });
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

    return withTransaction(async (client) => {
      const created = await this.repository.createDiscount(
        productId,
        dto,
        client,
      );
      await this.recordProductUpdated(client, productId);
      return created;
    });
  }

  async deleteDiscount(id: string): Promise<void> {
    await withTransaction(async (client) => {
      const productId = await this.repository.deleteDiscount(id, client);
      if (!productId) {
        throw new NotFoundException(`Discount with id '${id}' not found`);
      }
      await this.recordProductUpdated(client, productId);
    });
  }

  /**
   * Records `product.updated` for a product changed through one of its child
   * rows. The read uses the caller's transaction client, so the payload
   * describes the product as it will commit — for the delete paths that means
   * reading after the child row is gone, which is the state consumers need.
   */
  private async recordProductUpdated(
    client: QueryHandle,
    productId: string,
  ): Promise<void> {
    const product = await this.repository.findById(productId, client);
    if (!product) return;
    await this.outbox.recordProduct(client, product);
  }
}

import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventsService } from '../events/events.service.js';
import { ProductsRepository } from '../products/products.repository.js';
import { BadgesRepository } from './badges.repository.js';
import { Badge, ProductBadgeItem } from './badges.types.js';
import { AssignProductBadgesDto } from './dto/assign-product-badges.dto.js';
import { CreateBadgeDto } from './dto/create-badge.dto.js';
import { UpdateBadgeDto } from './dto/update-badge.dto.js';

@Injectable()
export class BadgesService {
  constructor(
    private readonly badgesRepository: BadgesRepository,
    @Optional() private readonly eventsService?: EventsService,
    @Optional() private readonly productsRepository?: ProductsRepository,
  ) {}

  async getBadges(options: { activeOnly?: boolean } = {}): Promise<Badge[]> {
    return this.badgesRepository.findAll(options);
  }

  async getBadgeById(id: string): Promise<Badge> {
    const badge = await this.badgesRepository.findById(id);
    if (!badge) {
      throw new NotFoundException(`Badge with ID '${id}' not found`);
    }
    return badge;
  }

  async createBadge(dto: CreateBadgeDto): Promise<Badge> {
    const existing = await this.badgesRepository.findByKey(dto.key);
    if (existing) {
      throw new ConflictException(`Badge with key '${dto.key}' already exists`);
    }
    return this.badgesRepository.create(dto);
  }

  async updateBadge(id: string, dto: UpdateBadgeDto): Promise<Badge> {
    const existing = await this.badgesRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Badge with ID '${id}' not found`);
    }

    if (dto.key && dto.key !== existing.key) {
      const duplicateKey = await this.badgesRepository.findByKey(dto.key);
      if (duplicateKey) {
        throw new ConflictException(`Badge with key '${dto.key}' already exists`);
      }
    }

    const updated = await this.badgesRepository.update(id, dto);
    if (!updated) {
      throw new NotFoundException(`Badge with ID '${id}' not found`);
    }
    return updated;
  }

  async deleteBadge(id: string): Promise<void> {
    const existing = await this.badgesRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Badge with ID '${id}' not found`);
    }
    await this.badgesRepository.delete(id);
  }

  async getProductBadges(productId: string): Promise<ProductBadgeItem[]> {
    return this.badgesRepository.getProductBadges(productId, { activeOnly: true });
  }

  async assignProductBadges(
    productId: string,
    dto: AssignProductBadgesDto,
  ): Promise<ProductBadgeItem[]> {
    const assigned = await this.badgesRepository.assignProductBadges(
      productId,
      dto.badges,
    );

    if (this.eventsService && this.productsRepository) {
      const product = await this.productsRepository.findById(productId);
      if (product) {
        await this.eventsService.publishProductUpdated({
          productId: product.id,
          sku: product.sku,
          name: product.name,
          slug: product.slug,
          description: product.description ?? undefined,
          categoryId: product.category?.id ?? undefined,
          categorySlug: product.category?.slug ?? undefined,
          brandId: product.brand?.id ?? undefined,
          brandName: product.brand?.name ?? undefined,
          price: product.price,
          stock: product.stock,
          imageUrl: product.images?.[0]?.url,
          status: product.status === 'active' ? 'active' : 'inactive',
          updatedAt: product.updatedAt,
        });
      }
    }

    return assigned;
  }
}

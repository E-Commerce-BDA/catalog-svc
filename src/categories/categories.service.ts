import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTransaction } from '../db/tx.js';
import { CatalogOutbox } from '../outbox/catalog-outbox.js';
import { CategoriesRepository } from './categories.repository.js';
import {
  Category,
  CategoryTreeItem,
} from './categories.types.js';
import { CategoryQueryDto } from './dto/category-query.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly repository: CategoriesRepository,
    private readonly outbox: CatalogOutbox,
  ) {}

  async getNavbarCategories(): Promise<Category[]> {
    return this.repository.findNavbar();
  }

  async getCategories(query: CategoryQueryDto = {}): Promise<Category[] | CategoryTreeItem[]> {
    if (query.navbar === 'true' || query.navbar === '1') {
      return this.repository.findNavbar();
    }

    const activeOnly = query.includeInactive !== 'true';

    if (query.tree === 'true' || query.tree === '1') {
      return this.getCategoryTree(activeOnly);
    }

    return this.repository.findAll({ activeOnly });
  }

  async getCategoryTree(activeOnly = true): Promise<CategoryTreeItem[]> {
    const flat = await this.repository.findAll({ activeOnly });
    return this.buildTree(flat);
  }

  async getCategoryBySlug(slug: string): Promise<Category> {
    const category = await this.repository.findBySlug(slug);
    if (!category) {
      throw new NotFoundException(`Category with slug '${slug}' not found`);
    }
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<Category> {
    const slug = dto.slug && dto.slug.trim().length > 0 ? slugify(dto.slug) : slugify(dto.name);

    if (!slug) {
      throw new BadRequestException('A valid category name or slug is required');
    }

    const existing = await this.repository.findBySlug(slug);
    if (existing) {
      throw new ConflictException(`Category with slug '${slug}' already exists`);
    }

    if (dto.parentId) {
      const parent = await this.repository.findById(dto.parentId);
      if (!parent) {
        throw new BadRequestException(`Parent category with id '${dto.parentId}' does not exist`);
      }
    }

    try {
      return await withTransaction(async (client) => {
        const created = await this.repository.create(
          {
            name: dto.name,
            slug,
            parentId: dto.parentId,
            description: dto.description,
            imageUrl: dto.imageUrl,
            isActive: dto.isActive,
            showInNavbar: dto.showInNavbar,
            showInMegamenu: dto.showInMegamenu,
            megamenuShowImages: dto.megamenuShowImages,
            sortOrder: dto.sortOrder,
            settings: dto.settings,
          },
          client,
        );

        await this.outbox.recordCategory(client, created);
        return created;
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique constraint')) {
        throw new ConflictException(`Category with slug '${slug}' already exists`);
      }
      throw err;
    }
  }

  async updateCategory(id: string, dto: UpdateCategoryDto): Promise<Category> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Category with id '${id}' not found`);
    }

    let slug = dto.slug;
    if (slug) {
      slug = slugify(slug);
      const duplicate = await this.repository.findBySlug(slug);
      if (duplicate && duplicate.id !== id) {
        throw new ConflictException(`Category with slug '${slug}' already exists`);
      }
    }

    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('A category cannot be its own parent');
      }
      const parent = await this.repository.findById(dto.parentId);
      if (!parent) {
        throw new BadRequestException(`Parent category with id '${dto.parentId}' does not exist`);
      }
    }

    return withTransaction(async (client) => {
      const updated = await this.repository.update(
        id,
        {
          name: dto.name,
          slug: slug ?? dto.slug,
          parentId: dto.parentId,
          description: dto.description,
          imageUrl: dto.imageUrl,
          isActive: dto.isActive,
          showInNavbar: dto.showInNavbar,
          showInMegamenu: dto.showInMegamenu,
          megamenuShowImages: dto.megamenuShowImages,
          sortOrder: dto.sortOrder,
          settings: dto.settings,
        },
        client,
      );

      if (!updated) {
        throw new NotFoundException(`Category with id '${id}' not found`);
      }

      await this.outbox.recordCategory(client, updated);
      return updated;
    });
  }

  async deleteCategory(id: string): Promise<void> {
    await withTransaction(async (client) => {
      const deleted = await this.repository.softDelete(id, client);
      if (!deleted) {
        throw new NotFoundException(`Category with id '${id}' not found`);
      }

      // `softDelete` returns the row it wrote, so `isActive` and `updatedAt`
      // in the event are the values that committed.
      await this.outbox.recordCategory(client, deleted);
    });
  }

  private buildTree(categories: Category[]): CategoryTreeItem[] {
    const map = new Map<string, CategoryTreeItem>();
    const roots: CategoryTreeItem[] = [];

    // First pass: create node objects
    for (const cat of categories) {
      map.set(cat.id, { ...cat, children: [] });
    }

    // Second pass: link children to parent or root
    for (const cat of categories) {
      const node = map.get(cat.id);
      if (!node) continue;

      if (cat.parentId && map.has(cat.parentId)) {
        map.get(cat.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }
}

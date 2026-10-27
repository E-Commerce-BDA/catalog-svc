import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  constructor(private readonly repository: CategoriesRepository) {}

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
      return await this.repository.create({ ...dto, slug });
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

    const updated = await this.repository.update(id, {
      ...dto,
      ...(slug ? { slug } : {}),
    });

    if (!updated) {
      throw new NotFoundException(`Category with id '${id}' not found`);
    }

    return updated;
  }

  async deleteCategory(id: string): Promise<void> {
    const deleted = await this.repository.softDelete(id);
    if (!deleted) {
      throw new NotFoundException(`Category with id '${id}' not found`);
    }
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

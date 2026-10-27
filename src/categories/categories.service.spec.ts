import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CategoriesRepository } from './categories.repository.js';
import { CategoriesService } from './categories.service.js';
import { Category } from './categories.types.js';

describe('CategoriesService', () => {
  let service: CategoriesService;
  let repository: {
    findNavbar: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    findBySlug: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
  };

  const sampleCategory: Category = {
    id: '0190a8b0-0000-7000-8000-000000000001',
    parentId: null,
    name: 'Apparel',
    slug: 'apparel',
    description: 'Clothing',
    imageUrl: null,
    isActive: true,
    showInNavbar: true,
    showInMegamenu: true,
    megamenuShowImages: false,
    sortOrder: 1,
    settings: {},
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };

  const subCategory: Category = {
    id: '0190a8b0-0000-7000-8000-000000000003',
    parentId: '0190a8b0-0000-7000-8000-000000000001',
    name: 'T-Shirts',
    slug: 't-shirts',
    description: 'Graphic tees',
    imageUrl: null,
    isActive: true,
    showInNavbar: false,
    showInMegamenu: true,
    megamenuShowImages: false,
    sortOrder: 1,
    settings: {},
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };

  beforeEach(() => {
    repository = {
      findNavbar: vi.fn(),
      findAll: vi.fn(),
      findBySlug: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
    };
    service = new CategoriesService(repository as unknown as CategoriesRepository);
  });

  it('retrieves navbar categories using findNavbar', async () => {
    repository.findNavbar.mockResolvedValue([sampleCategory]);

    const result = await service.getCategories({ navbar: 'true' });
    expect(repository.findNavbar).toHaveBeenCalledTimes(1);
    expect(result).toEqual([sampleCategory]);
  });

  it('builds a hierarchical tree from flat categories', async () => {
    repository.findAll.mockResolvedValue([sampleCategory, subCategory]);

    const tree = await service.getCategoryTree();
    expect(tree.length).toBe(1);
    expect(tree[0].id).toBe(sampleCategory.id);
    expect(tree[0].children.length).toBe(1);
    expect(tree[0].children[0].id).toBe(subCategory.id);
  });

  it('retrieves a category by slug', async () => {
    repository.findBySlug.mockResolvedValue(sampleCategory);

    const result = await service.getCategoryBySlug('apparel');
    expect(result).toEqual(sampleCategory);
  });

  it('throws NotFoundException if slug is not found', async () => {
    repository.findBySlug.mockResolvedValue(null);

    await expect(service.getCategoryBySlug('unknown')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('creates category with auto-generated slug', async () => {
    repository.findBySlug.mockResolvedValue(null);
    repository.create.mockResolvedValue({
      ...sampleCategory,
      name: 'New Arrivals',
      slug: 'new-arrivals',
    });

    const result = await service.createCategory({ name: 'New Arrivals' });
    expect(result.slug).toBe('new-arrivals');
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Arrivals', slug: 'new-arrivals' }),
    );
  });

  it('throws ConflictException on duplicate slug', async () => {
    repository.findBySlug.mockResolvedValue(sampleCategory);

    await expect(
      service.createCategory({ name: 'Apparel', slug: 'apparel' }),
    ).rejects.toThrow(ConflictException);
  });

  it('prevents self-parenting on update', async () => {
    repository.findById.mockResolvedValue(sampleCategory);

    await expect(
      service.updateCategory(sampleCategory.id, { parentId: sampleCategory.id }),
    ).rejects.toThrow(BadRequestException);
  });

  it('soft deletes category or throws NotFoundException', async () => {
    repository.softDelete.mockResolvedValue(true);
    await expect(service.deleteCategory(sampleCategory.id)).resolves.toBeUndefined();

    repository.softDelete.mockResolvedValue(false);
    await expect(service.deleteCategory('unknown-id')).rejects.toThrow(
      NotFoundException,
    );
  });
});

import { CategoriesController } from './categories.controller.js';
import { CategoriesService } from './categories.service.js';
import { Category, CategoryTreeItem } from './categories.types.js';

describe('CategoriesController', () => {
  let controller: CategoriesController;
  let service: {
    getCategories: ReturnType<typeof vi.fn>;
    getCategoryTree: ReturnType<typeof vi.fn>;
    getCategoryBySlug: ReturnType<typeof vi.fn>;
    createCategory: ReturnType<typeof vi.fn>;
    updateCategory: ReturnType<typeof vi.fn>;
    deleteCategory: ReturnType<typeof vi.fn>;
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

  beforeEach(() => {
    service = {
      getCategories: vi.fn(),
      getCategoryTree: vi.fn(),
      getCategoryBySlug: vi.fn(),
      createCategory: vi.fn(),
      updateCategory: vi.fn(),
      deleteCategory: vi.fn(),
    };
    controller = new CategoriesController(service as unknown as CategoriesService);
  });

  it('delegates getCategories to service', async () => {
    service.getCategories.mockResolvedValue([sampleCategory]);

    const result = await controller.getCategories({ navbar: 'true' });
    expect(result).toEqual({ data: [sampleCategory] });
    expect(service.getCategories).toHaveBeenCalledWith({ navbar: 'true' });
  });

  it('delegates getCategoryTree to service', async () => {
    const treeItem: CategoryTreeItem = { ...sampleCategory, children: [] };
    service.getCategoryTree.mockResolvedValue([treeItem]);

    const result = await controller.getCategoryTree();
    expect(result).toEqual({ data: [treeItem] });
  });

  it('delegates getCategoryBySlug to service', async () => {
    service.getCategoryBySlug.mockResolvedValue(sampleCategory);

    const result = await controller.getCategoryBySlug('apparel');
    expect(result).toEqual({ category: sampleCategory });
    expect(service.getCategoryBySlug).toHaveBeenCalledWith('apparel');
  });

  it('delegates createCategory to service', async () => {
    service.createCategory.mockResolvedValue(sampleCategory);

    const result = await controller.createCategory({ name: 'Apparel' });
    expect(result).toEqual({ category: sampleCategory });
    expect(service.createCategory).toHaveBeenCalledWith({ name: 'Apparel' });
  });

  it('delegates updateCategory to service', async () => {
    service.updateCategory.mockResolvedValue(sampleCategory);

    const result = await controller.updateCategory(sampleCategory.id, { name: 'Apparel Updated' });
    expect(result).toEqual({ category: sampleCategory });
  });

  it('delegates deleteCategory to service', async () => {
    service.deleteCategory.mockResolvedValue(undefined);

    await expect(controller.deleteCategory(sampleCategory.id)).resolves.toBeUndefined();
    expect(service.deleteCategory).toHaveBeenCalledWith(sampleCategory.id);
  });
});

import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { ProductDetail, ProductListItem } from './products.types.js';

describe('ProductsController', () => {
  let controller: ProductsController;
  let service: {
    getProducts: ReturnType<typeof vi.fn>;
    getProductById: ReturnType<typeof vi.fn>;
    getProductBySlug: ReturnType<typeof vi.fn>;
    createProduct: ReturnType<typeof vi.fn>;
    updateProduct: ReturnType<typeof vi.fn>;
    deleteProduct: ReturnType<typeof vi.fn>;
    createVariant: ReturnType<typeof vi.fn>;
    createOption: ReturnType<typeof vi.fn>;
    createImage: ReturnType<typeof vi.fn>;
    createDiscount: ReturnType<typeof vi.fn>;
  };

  const sampleListItem: ProductListItem = {
    id: '0190a8b0-0000-7000-8000-000000000101',
    sku: 'TEE-MAIN',
    name: 'Fixture Tee',
    slug: 'fixture-tee',
    shortDescription: 'Heavyweight organic cotton tee',
    price: 79.99,
    compareAtPrice: null,
    effectivePrice: 79.99,
    stock: 150,
    status: 'active',
    categoryId: '0190a8b0-0000-7000-8000-000000000003',
    categoryName: 'T-Shirts',
    categorySlug: 't-shirts',
    brandId: '0190a8b0-0000-7000-8000-000000000011',
    brandName: 'Acme Essentials',
    brandSlug: 'acme-essentials',
    primaryImageUrl: '/images/fixture-tee.jpg',
    tags: ['apparel', 'cotton'],
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };

  const sampleDetail: ProductDetail = {
    id: '0190a8b0-0000-7000-8000-000000000101',
    sku: 'TEE-MAIN',
    name: 'Fixture Tee',
    slug: 'fixture-tee',
    shortDescription: 'Heavyweight organic cotton tee',
    description: 'Detailed description',
    price: 79.99,
    compareAtPrice: null,
    effectivePrice: 79.99,
    stock: 150,
    status: 'active',
    category: { id: '0190a8b0-0000-7000-8000-000000000003', name: 'T-Shirts', slug: 't-shirts' },
    brand: { id: '0190a8b0-0000-7000-8000-000000000011', name: 'Acme Essentials', slug: 'acme-essentials', logoUrl: null },
    tags: ['apparel'],
    attributes: {},
    photoSettings: {},
    images: [],
    options: [],
    variants: [],
    activeDiscount: null,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };

  beforeEach(() => {
    service = {
      getProducts: vi.fn(),
      getProductById: vi.fn(),
      getProductBySlug: vi.fn(),
      createProduct: vi.fn(),
      updateProduct: vi.fn(),
      deleteProduct: vi.fn(),
      createVariant: vi.fn(),
      createOption: vi.fn(),
      createImage: vi.fn(),
      createDiscount: vi.fn(),
    };
    controller = new ProductsController(service as unknown as ProductsService);
  });

  it('delegates getProducts to service', async () => {
    service.getProducts.mockResolvedValue({
      data: [sampleListItem],
      nextCursor: null,
    });

    const res = await controller.getProducts({});
    expect(res).toEqual({ data: [sampleListItem], nextCursor: null });
    expect(service.getProducts).toHaveBeenCalledWith({});
  });

  it('delegates getProductBySlug to service', async () => {
    service.getProductBySlug.mockResolvedValue(sampleDetail);

    const res = await controller.getProductBySlug('fixture-tee');
    expect(res).toEqual({ product: sampleDetail });
    expect(service.getProductBySlug).toHaveBeenCalledWith('fixture-tee');
  });

  it('delegates createProduct to service', async () => {
    service.createProduct.mockResolvedValue(sampleDetail);

    const res = await controller.createProduct({
      sku: 'TEE-MAIN',
      name: 'Fixture Tee',
      price: 79.99,
    });
    expect(res).toEqual({ product: sampleDetail });
  });

  it('delegates deleteProduct to service', async () => {
    service.deleteProduct.mockResolvedValue(undefined);

    await expect(controller.deleteProduct(sampleDetail.id)).resolves.toBeUndefined();
    expect(service.deleteProduct).toHaveBeenCalledWith(sampleDetail.id);
  });
});

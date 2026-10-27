import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ProductsRepository } from './products.repository.js';
import { ProductsService } from './products.service.js';
import { ProductDetail, ProductListItem } from './products.types.js';

describe('ProductsService', () => {
  let service: ProductsService;
  let repository: {
    findList: ReturnType<typeof vi.fn>;
    findDetail: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findBySlug: ReturnType<typeof vi.fn>;
    findBySku: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
    createVariant: ReturnType<typeof vi.fn>;
    updateVariant: ReturnType<typeof vi.fn>;
    findVariantById: ReturnType<typeof vi.fn>;
    deleteVariant: ReturnType<typeof vi.fn>;
    createOption: ReturnType<typeof vi.fn>;
    createImage: ReturnType<typeof vi.fn>;
    updateImage: ReturnType<typeof vi.fn>;
    deleteImage: ReturnType<typeof vi.fn>;
    createDiscount: ReturnType<typeof vi.fn>;
    deleteDiscount: ReturnType<typeof vi.fn>;
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
    repository = {
      findList: vi.fn(),
      findDetail: vi.fn(),
      findById: vi.fn(),
      findBySlug: vi.fn(),
      findBySku: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      createVariant: vi.fn(),
      updateVariant: vi.fn(),
      findVariantById: vi.fn(),
      deleteVariant: vi.fn(),
      createOption: vi.fn(),
      createImage: vi.fn(),
      updateImage: vi.fn(),
      deleteImage: vi.fn(),
      createDiscount: vi.fn(),
      deleteDiscount: vi.fn(),
    };
    service = new ProductsService(repository as unknown as ProductsRepository);
  });

  it('delegates getProducts to findList', async () => {
    repository.findList.mockResolvedValue({
      data: [sampleListItem],
      nextCursor: null,
    });

    const res = await service.getProducts({});
    expect(res.data).toEqual([sampleListItem]);
    expect(repository.findList).toHaveBeenCalledWith({});
  });

  it('retrieves product detail by slug', async () => {
    repository.findDetail.mockResolvedValue(sampleDetail);

    const res = await service.getProductBySlug('fixture-tee');
    expect(res).toEqual(sampleDetail);
    expect(repository.findDetail).toHaveBeenCalledWith({ slug: 'fixture-tee' });
  });

  it('throws NotFoundException if slug not found', async () => {
    repository.findDetail.mockResolvedValue(null);

    await expect(service.getProductBySlug('unknown-slug')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('creates product and checks uniqueness', async () => {
    repository.findBySku.mockResolvedValue(null);
    repository.findBySlug.mockResolvedValue(null);
    repository.create.mockResolvedValue(sampleDetail);

    const res = await service.createProduct({
      sku: 'TEE-MAIN',
      name: 'Fixture Tee',
      price: 79.99,
    });

    expect(res).toEqual(sampleDetail);
    expect(repository.create).toHaveBeenCalled();
  });

  it('throws ConflictException on duplicate SKU', async () => {
    repository.findBySku.mockResolvedValue({ id: 'existing' });

    await expect(
      service.createProduct({
        sku: 'TEE-MAIN',
        name: 'Fixture Tee',
        price: 79.99,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('creates variant for existing product', async () => {
    repository.findById.mockResolvedValue({ id: sampleDetail.id });
    repository.createVariant.mockResolvedValue({
      id: 'var-1',
      productId: sampleDetail.id,
      sku: 'TEE-BLK-S',
      price: 79.99,
      stock: 10,
      imageUrl: null,
      isActive: true,
      options: [],
      createdAt: '2026-10-27T00:00:00.000Z',
      updatedAt: '2026-10-27T00:00:00.000Z',
    });

    const variant = await service.createVariant(sampleDetail.id, {
      sku: 'TEE-BLK-S',
      price: 79.99,
    });

    expect(variant.sku).toBe('TEE-BLK-S');
  });

  it('throws BadRequestException if percentage discount exceeds 100', async () => {
    repository.findById.mockResolvedValue({ id: sampleDetail.id });

    await expect(
      service.createDiscount(sampleDetail.id, {
        discountType: 'percent',
        value: 120,
        startsAt: new Date().toISOString(),
        endsAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

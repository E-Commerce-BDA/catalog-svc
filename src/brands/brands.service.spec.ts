import { ConflictException, NotFoundException } from '@nestjs/common';
import { BrandsRepository } from './brands.repository.js';
import { BrandsService } from './brands.service.js';
import { Brand } from './brands.types.js';

describe('BrandsService', () => {
  let service: BrandsService;
  let repository: {
    findAll: ReturnType<typeof vi.fn>;
    findBySlug: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
  };

  const sampleBrand: Brand = {
    id: '0190a8b0-0000-7000-8000-000000000011',
    name: 'Acme Essentials',
    slug: 'acme-essentials',
    logoUrl: null,
    description: 'Modern daily apparel essentials',
    isActive: true,
    sortOrder: 1,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };

  beforeEach(() => {
    repository = {
      findAll: vi.fn(),
      findBySlug: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
    };
    service = new BrandsService(repository as unknown as BrandsRepository);
  });

  it('retrieves active brands by default', async () => {
    repository.findAll.mockResolvedValue([sampleBrand]);

    const result = await service.getBrands();
    expect(repository.findAll).toHaveBeenCalledWith({ activeOnly: true });
    expect(result).toEqual([sampleBrand]);
  });

  it('retrieves a brand by slug', async () => {
    repository.findBySlug.mockResolvedValue(sampleBrand);

    const result = await service.getBrandBySlug('acme-essentials');
    expect(result).toEqual(sampleBrand);
  });

  it('throws NotFoundException if slug not found', async () => {
    repository.findBySlug.mockResolvedValue(null);

    await expect(service.getBrandBySlug('unknown')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('creates brand with auto-generated slug', async () => {
    repository.findBySlug.mockResolvedValue(null);
    repository.create.mockResolvedValue({
      ...sampleBrand,
      name: 'Nordic Goods',
      slug: 'nordic-goods',
    });

    const result = await service.createBrand({ name: 'Nordic Goods' });
    expect(result.slug).toBe('nordic-goods');
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Nordic Goods', slug: 'nordic-goods' }),
    );
  });

  it('throws ConflictException on duplicate slug', async () => {
    repository.findBySlug.mockResolvedValue(sampleBrand);

    await expect(
      service.createBrand({ name: 'Acme', slug: 'acme-essentials' }),
    ).rejects.toThrow(ConflictException);
  });

  it('soft deletes brand or throws NotFoundException', async () => {
    repository.softDelete.mockResolvedValue(true);
    await expect(service.deleteBrand(sampleBrand.id)).resolves.toBeUndefined();

    repository.softDelete.mockResolvedValue(false);
    await expect(service.deleteBrand('unknown-id')).rejects.toThrow(
      NotFoundException,
    );
  });
});

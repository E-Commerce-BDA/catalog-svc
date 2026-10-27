import { BrandsController } from './brands.controller.js';
import { BrandsService } from './brands.service.js';
import { Brand } from './brands.types.js';

describe('BrandsController', () => {
  let controller: BrandsController;
  let service: {
    getBrands: ReturnType<typeof vi.fn>;
    getBrandBySlug: ReturnType<typeof vi.fn>;
    createBrand: ReturnType<typeof vi.fn>;
    updateBrand: ReturnType<typeof vi.fn>;
    deleteBrand: ReturnType<typeof vi.fn>;
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
    service = {
      getBrands: vi.fn(),
      getBrandBySlug: vi.fn(),
      createBrand: vi.fn(),
      updateBrand: vi.fn(),
      deleteBrand: vi.fn(),
    };
    controller = new BrandsController(service as unknown as BrandsService);
  });

  it('delegates getBrands to service', async () => {
    service.getBrands.mockResolvedValue([sampleBrand]);

    const result = await controller.getBrands({});
    expect(result).toEqual({ data: [sampleBrand] });
  });

  it('delegates getBrandBySlug to service', async () => {
    service.getBrandBySlug.mockResolvedValue(sampleBrand);

    const result = await controller.getBrandBySlug('acme-essentials');
    expect(result).toEqual({ brand: sampleBrand });
    expect(service.getBrandBySlug).toHaveBeenCalledWith('acme-essentials');
  });

  it('delegates createBrand to service', async () => {
    service.createBrand.mockResolvedValue(sampleBrand);

    const result = await controller.createBrand({ name: 'Acme Essentials' });
    expect(result).toEqual({ brand: sampleBrand });
  });

  it('delegates updateBrand to service', async () => {
    service.updateBrand.mockResolvedValue(sampleBrand);

    const result = await controller.updateBrand(sampleBrand.id, { name: 'Acme Updated' });
    expect(result).toEqual({ brand: sampleBrand });
  });

  it('delegates deleteBrand to service', async () => {
    service.deleteBrand.mockResolvedValue(undefined);

    await expect(controller.deleteBrand(sampleBrand.id)).resolves.toBeUndefined();
    expect(service.deleteBrand).toHaveBeenCalledWith(sampleBrand.id);
  });
});

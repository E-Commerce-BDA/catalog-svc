import { ConflictException, NotFoundException } from '@nestjs/common';
import { CatalogOutbox } from '../outbox/catalog-outbox.js';
import { ProductsRepository } from '../products/products.repository.js';
import { BadgesRepository } from './badges.repository.js';
import { BadgesService } from './badges.service.js';
import { Badge, ProductBadgeItem } from './badges.types.js';

// No database in unit tests: run the mutation callback directly.
vi.mock('../db/tx.js', () => ({
  withTransaction: <T>(action: (client: unknown) => Promise<T>): Promise<T> =>
    action({ query: () => Promise.resolve({ rows: [] }) }),
}));

describe('BadgesService', () => {
  let service: BadgesService;
  let outbox: {
    recordProduct: ReturnType<typeof vi.fn>;
  };
  let productsRepository: {
    findById: ReturnType<typeof vi.fn>;
  };
  let repository: {
    findAll: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByKey: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getProductBadges: ReturnType<typeof vi.fn>;
    assignProductBadges: ReturnType<typeof vi.fn>;
  };

  const sampleBadge: Badge = {
    id: 'b0000000-0000-0000-0000-000000000001',
    key: 'sale',
    label: 'Sale',
    bg: '#ef4444',
    textColor: '#ffffff',
    borderStyle: 'solid',
    isActive: true,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
  };

  beforeEach(() => {
    repository = {
      findAll: vi.fn(),
      findById: vi.fn(),
      findByKey: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getProductBadges: vi.fn(),
      assignProductBadges: vi.fn(),
    };
    outbox = {
      recordProduct: vi.fn(),
    };
    productsRepository = {
      findById: vi.fn(),
    };
    service = new BadgesService(
      repository as unknown as BadgesRepository,
      outbox as unknown as CatalogOutbox,
      productsRepository as unknown as ProductsRepository,
    );
  });

  it('retrieves badges list with filter', async () => {
    repository.findAll.mockResolvedValue([sampleBadge]);
    const result = await service.getBadges({ activeOnly: true });
    expect(repository.findAll).toHaveBeenCalledWith({ activeOnly: true });
    expect(result).toEqual([sampleBadge]);
  });

  it('retrieves badge by id', async () => {
    repository.findById.mockResolvedValue(sampleBadge);
    const result = await service.getBadgeById(sampleBadge.id);
    expect(result).toEqual(sampleBadge);
  });

  it('throws NotFoundException when badge id is not found', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(service.getBadgeById('non-existent')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('creates badge successfully', async () => {
    repository.findByKey.mockResolvedValue(null);
    repository.create.mockResolvedValue(sampleBadge);

    const result = await service.createBadge({
      key: 'sale',
      label: 'Sale',
      bg: '#ef4444',
      textColor: '#ffffff',
    });
    expect(result).toEqual(sampleBadge);
  });

  it('throws ConflictException on duplicate badge key on create', async () => {
    repository.findByKey.mockResolvedValue(sampleBadge);
    await expect(
      service.createBadge({
        key: 'sale',
        label: 'Sale',
        bg: '#ef4444',
        textColor: '#ffffff',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('updates badge and checks key conflicts', async () => {
    repository.findById.mockResolvedValue(sampleBadge);
    repository.findByKey.mockResolvedValue(null);
    repository.update.mockResolvedValue({ ...sampleBadge, label: 'Super Sale' });

    const result = await service.updateBadge(sampleBadge.id, {
      label: 'Super Sale',
    });
    expect(result.label).toBe('Super Sale');
  });

  it('assigns product badges', async () => {
    const assigned: ProductBadgeItem[] = [
      {
        id: sampleBadge.id,
        key: sampleBadge.key,
        label: sampleBadge.label,
        bg: sampleBadge.bg,
        textColor: sampleBadge.textColor,
        sortOrder: 0,
      },
    ];
    repository.assignProductBadges.mockResolvedValue(assigned);
    productsRepository.findById.mockResolvedValue({
      id: 'p1',
      sku: 'TEE-MAIN',
      name: 'Fixture Tee',
      slug: 'fixture-tee',
      status: 'active',
      price: 79.99,
      stock: 150,
      updated_at: new Date('2026-10-30T00:00:00.000Z'),
    });

    const result = await service.assignProductBadges('p1', {
      badges: [{ badgeId: sampleBadge.id, sortOrder: 0 }],
    });
    expect(result).toEqual(assigned);
    // Badge assignment changes what a card renders, so it emits like any other
    // product mutation (cat-007 coverage expansion).
    expect(outbox.recordProduct).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'p1' }),
    );
  });
});

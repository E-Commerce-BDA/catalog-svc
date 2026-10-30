import { BadgesController, ProductBadgesController } from './badges.controller.js';
import { BadgesService } from './badges.service.js';
import { Badge, ProductBadgeItem } from './badges.types.js';

describe('BadgesController', () => {
  let controller: BadgesController;
  let service: {
    getBadges: ReturnType<typeof vi.fn>;
    getBadgeById: ReturnType<typeof vi.fn>;
    createBadge: ReturnType<typeof vi.fn>;
    updateBadge: ReturnType<typeof vi.fn>;
    deleteBadge: ReturnType<typeof vi.fn>;
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
    service = {
      getBadges: vi.fn(),
      getBadgeById: vi.fn(),
      createBadge: vi.fn(),
      updateBadge: vi.fn(),
      deleteBadge: vi.fn(),
    };
    controller = new BadgesController(service as unknown as BadgesService);
  });

  it('returns data array on getBadges', async () => {
    service.getBadges.mockResolvedValue([sampleBadge]);
    const res = await controller.getBadges('true');
    expect(res).toEqual({ data: [sampleBadge] });
  });

  it('returns badge on getBadgeById', async () => {
    service.getBadgeById.mockResolvedValue(sampleBadge);
    const res = await controller.getBadgeById(sampleBadge.id);
    expect(res).toEqual({ badge: sampleBadge });
  });

  it('creates badge', async () => {
    service.createBadge.mockResolvedValue(sampleBadge);
    const res = await controller.createBadge({
      key: 'sale',
      label: 'Sale',
      bg: '#ef4444',
      textColor: '#ffffff',
    });
    expect(res).toEqual({ badge: sampleBadge });
  });
});

describe('ProductBadgesController', () => {
  let controller: ProductBadgesController;
  let service: {
    getProductBadges: ReturnType<typeof vi.fn>;
    assignProductBadges: ReturnType<typeof vi.fn>;
  };

  const sampleBadgeItem: ProductBadgeItem = {
    id: 'b0000000-0000-0000-0000-000000000001',
    key: 'sale',
    label: 'Sale',
    bg: '#ef4444',
    textColor: '#ffffff',
    sortOrder: 0,
  };

  beforeEach(() => {
    service = {
      getProductBadges: vi.fn(),
      assignProductBadges: vi.fn(),
    };
    controller = new ProductBadgesController(service as unknown as BadgesService);
  });

  it('returns product badges', async () => {
    service.getProductBadges.mockResolvedValue([sampleBadgeItem]);
    const res = await controller.getProductBadges('p1');
    expect(res).toEqual({ badges: [sampleBadgeItem] });
  });

  it('assigns product badges', async () => {
    service.assignProductBadges.mockResolvedValue([sampleBadgeItem]);
    const res = await controller.assignProductBadges('p1', {
      badges: [{ badgeId: sampleBadgeItem.id, sortOrder: 0 }],
    });
    expect(res).toEqual({ badges: [sampleBadgeItem] });
  });
});

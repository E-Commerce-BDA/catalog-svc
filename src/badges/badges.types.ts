export interface BadgeRow {
  id: string;
  key: string;
  label: string;
  bg: string;
  text_color: string;
  border_color: string | null;
  border_style: 'solid' | 'dashed' | 'dotted';
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface Badge {
  id: string;
  key: string;
  label: string;
  bg: string;
  textColor: string;
  borderColor?: string | null;
  borderStyle: 'solid' | 'dashed' | 'dotted';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Row shape of the `product_badges ⋈ badges` query in `getProductBadges`: the
 * badge id comes from the joined table, everything else is the badge itself
 * plus the assignment's ordering.
 */
export interface ProductBadgeRow {
  id: string;
  product_id: string;
  badge_id: string;
  sort_order: number;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  key: string;
  label: string;
  bg: string;
  text_color: string;
  border_color: string | null;
  border_style: 'solid' | 'dashed' | 'dotted';
}

export interface ProductBadgeItem {
  id: string;
  key: string;
  label: string;
  bg: string;
  textColor: string;
  borderColor?: string | null;
  borderStyle?: 'solid' | 'dashed' | 'dotted';
  sortOrder?: number;
}

export function mapBadgeRow(row: BadgeRow): Badge {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    bg: row.bg,
    textColor: row.text_color,
    borderColor: row.border_color ?? undefined,
    borderStyle: row.border_style,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

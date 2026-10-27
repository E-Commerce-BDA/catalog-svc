export interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
  is_active: boolean;
  show_in_navbar: boolean;
  show_in_megamenu: boolean;
  megamenu_show_images: boolean;
  sort_order: number;
  settings: Record<string, unknown>;
  deleted_at?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  isActive: boolean;
  showInNavbar: boolean;
  showInMegamenu: boolean;
  megamenuShowImages: boolean;
  sortOrder: number;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryTreeItem extends Category {
  children: CategoryTreeItem[];
}

export function mapCategoryRow(row: CategoryRow): Category {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    imageUrl: row.image_url,
    isActive: row.is_active,
    showInNavbar: row.show_in_navbar,
    showInMegamenu: row.show_in_megamenu,
    megamenuShowImages: row.megamenu_show_images,
    sortOrder: Number(row.sort_order),
    settings: (row.settings && typeof row.settings === 'object') ? row.settings : {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

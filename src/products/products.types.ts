import type { ProductBadgeItem } from '../badges/badges.types.js';

export interface ProductCardOptionValueItem {
  id?: string;
  value: string;
  position?: number;
  swatchHex?: string | null;
  swatchImageUrl?: string | null;
  inStock?: boolean;
}

export interface ProductCardOptionItem {
  id?: string;
  name: string;
  displayType: 'text' | 'pill' | 'swatch';
  showOnCard: boolean;
  values: ProductCardOptionValueItem[];
}

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  slug: string;
  short_description: string | null;
  description: string | null;
  category_id: string | null;
  brand_id: string | null;
  price: string | number;
  compare_at_price: string | number | null;
  stock: number;
  status: 'draft' | 'active' | 'archived';
  tags: string[] | null;
  attributes: Record<string, unknown>;
  photo_settings: Record<string, unknown>;
  card_settings?: Record<string, unknown>;
  source: string;
  external_id: string | null;
  weight_g: number | null;
  deleted_at?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  primary_image_url?: string | null;
  category_name?: string | null;
  category_slug?: string | null;
  brand_name?: string | null;
  brand_slug?: string | null;
  badges?: ProductBadgeItem[];
  card_options?: ProductCardOptionItem[];
}

export interface ProductListItem {
  id: string;
  sku: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  price: number;
  compareAtPrice: number | null;
  stock: number;
  status: 'draft' | 'active' | 'archived';
  categoryId: string | null;
  categoryName: string | null;
  categorySlug: string | null;
  brandId: string | null;
  brandName: string | null;
  brandSlug: string | null;
  primaryImageUrl: string | null;
  tags: string[];
  effectivePrice: number;
  createdAt: string;
  updatedAt: string;
  cardSettings?: Record<string, unknown>;
  badges?: ProductBadgeItem[];
  cardOptions?: ProductCardOptionItem[];
}

export interface ProductVariantOptionValue {
  optionId: string;
  optionName: string;
  optionValueId: string;
  value: string;
}

export interface ProductVariant {
  id: string;
  productId: string;
  sku: string;
  price: number;
  stock: number;
  imageUrl: string | null;
  isActive: boolean;
  options: ProductVariantOptionValue[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductOptionValue {
  id: string;
  optionId: string;
  value: string;
  position: number;
  swatchHex?: string | null;
  swatchImageUrl?: string | null;
}

export interface ProductOption {
  id: string;
  productId: string;
  name: string;
  position: number;
  displayType: 'text' | 'pill' | 'swatch';
  showOnCard: boolean;
  values: ProductOptionValue[];
}

export interface ProductImage {
  id: string;
  productId: string;
  variantId: string | null;
  url: string;
  alt: string | null;
  sortOrder: number;
  isPrimary: boolean;
  createdAt: string;
}

export interface ProductDiscount {
  id: string;
  productId: string;
  discountType: 'percent' | 'fixed';
  value: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

export interface ProductDetail {
  id: string;
  sku: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  description: string | null;
  price: number;
  compareAtPrice: number | null;
  effectivePrice: number;
  stock: number;
  status: 'draft' | 'active' | 'archived';
  category: { id: string; name: string; slug: string } | null;
  brand: { id: string; name: string; slug: string; logoUrl: string | null } | null;
  tags: string[];
  attributes: Record<string, unknown>;
  photoSettings: Record<string, unknown>;
  cardSettings?: Record<string, unknown>;
  badges?: ProductBadgeItem[];
  cardOptions?: ProductCardOptionItem[];
  images: ProductImage[];
  options: ProductOption[];
  variants: ProductVariant[];
  activeDiscount: ProductDiscount | null;
  createdAt: string;
  updatedAt: string;
}

export function computeEffectivePrice(
  basePrice: number,
  discount: { discountType: 'percent' | 'fixed'; value: number } | null,
): number {
  if (!discount) return basePrice;
  if (discount.discountType === 'percent') {
    const discounted = basePrice * (1 - discount.value / 100);
    return Math.max(0, Math.round(discounted * 100) / 100);
  }
  return Math.max(0, Math.round((basePrice - discount.value) * 100) / 100);
}

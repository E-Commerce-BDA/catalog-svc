export type StockMovementReason =
  | 'sale'
  | 'restock'
  | 'import'
  | 'admin_adjustment'
  | 'return'
  | 'cancel';

export interface StockMovement {
  id: string;
  productId: string;
  variantId: string | null;
  qtyChange: number;
  reason: StockMovementReason;
  orderId: string | null;
  qtyAfter: number;
  createdAt: string;
}

export interface StockLevel {
  productId: string;
  variantId: string | null;
  sku: string;
  stock: number;
  available: boolean;
}

export interface CatalogProductSnapshot {
  productId: string;
  variantId: string | null;
  productName: string;
  productSlug: string;
  imageUrl: string | null;
  variantLabel: string | null;
  unitPrice: number;
  effectivePrice: number;
  stock: number;
  available: boolean;
}

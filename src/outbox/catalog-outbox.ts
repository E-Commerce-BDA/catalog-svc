import { Inject, Injectable } from '@nestjs/common';
import type {
  CategoryUpdatedPayload,
  ProductUpdatedPayload,
} from '@ecom/contracts';
import type { OutboxStorePort, Queryable } from '@ecom/messaging';
import { OUTBOX_STORE } from '@ecom/messaging/nest';
import { v7 as uuidv7 } from 'uuid';
import type { Category } from '../categories/categories.types.js';
import type { ProductDetail, ProductRow } from '../products/products.types.js';

/**
 * Writes catalog events into `catalog.outbox`.
 *
 * The write must happen inside the transaction that mutated the row, so the
 * event and the catalog state commit or roll back together. Payload assembly
 * lives here rather than in the services because `store.write` validates it
 * against the contracts schema: a drifted payload now aborts the mutation
 * instead of publishing something downstream cannot parse.
 */
@Injectable()
export class CatalogOutbox {
  constructor(@Inject(OUTBOX_STORE) private readonly store: OutboxStorePort) {}

  /**
   * `product.updated` is emitted by every mutation that changes what a
   * storefront shows, including variants, options, images, discounts and badge
   * assignments — anything that would leave a cached card stale.
   */
  async recordProduct(
    client: Queryable,
    product: ProductDetail | ProductRow,
  ): Promise<string> {
    return this.store.write(client, {
      topic: 'product.updated',
      eventId: uuidv7(),
      aggregateType: 'product',
      aggregateId: product.id,
      // The row's own timestamp, not wall clock at publish time, so a replay
      // reproduces the original event.
      occurredAt: new Date(isDetail(product) ? product.updatedAt : product.updated_at),
      payload: toProductPayload(product),
    });
  }

  async recordCategory(client: Queryable, category: Category): Promise<string> {
    const payload: CategoryUpdatedPayload = {
      categoryId: category.id,
      name: category.name,
      slug: category.slug,
      isActive: category.isActive,
      imageUrl: category.imageUrl ?? undefined,
      parentId: category.parentId ?? undefined,
      updatedAt: category.updatedAt,
    };

    return this.store.write(client, {
      topic: 'category.updated',
      eventId: uuidv7(),
      aggregateType: 'category',
      aggregateId: category.id,
      occurredAt: new Date(category.updatedAt),
      payload,
    });
  }
}

/**
 * `ProductDetail` is the join-shaped read the controllers return; `ProductRow`
 * is the bare table row. The detail has a `category` object, the row only a
 * `category_id`, which is what makes the two distinguishable at runtime.
 */
function isDetail(product: ProductDetail | ProductRow): product is ProductDetail {
  return 'category' in product;
}

function toProductPayload(
  product: ProductDetail | ProductRow,
): ProductUpdatedPayload {
  // Fields both shapes carry. `Number()` normalises the `DECIMAL`-as-string
  // that `pg` returns for prices.
  const base = {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    slug: product.slug,
    description: product.description ?? undefined,
    price: Number(product.price),
    stock: Number(product.stock),
    status: (product.status === 'active' ? 'active' : 'inactive') as
      | 'active'
      | 'inactive',
  };

  if (isDetail(product)) {
    return {
      ...base,
      categoryId: product.category?.id ?? undefined,
      categorySlug: product.category?.slug ?? undefined,
      brandId: product.brand?.id ?? undefined,
      brandName: product.brand?.name ?? undefined,
      imageUrl: product.images?.[0]?.url,
      updatedAt: product.updatedAt,
    };
  }

  return {
    ...base,
    categoryId: product.category_id ?? undefined,
    categorySlug: product.category_slug ?? undefined,
    brandId: product.brand_id ?? undefined,
    brandName: product.brand_name ?? undefined,
    imageUrl: product.images?.[0]?.url ?? product.primary_image_url ?? undefined,
    updatedAt: new Date(product.updated_at).toISOString(),
  };
}

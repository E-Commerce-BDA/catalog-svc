import { Injectable, Logger } from '@nestjs/common';
import type {
  ProductImportedPayload,
  ProductVariantRef,
} from '@ecom/contracts';
import type { PoolClient } from 'pg';
import { slugify } from '../../categories/categories.service.js';
import { ProductImportRejectedError } from './import.errors.js';

/** What one applied import produced, for the handler's log line. */
export interface ImportWriteResult {
  productId: string;
  created: boolean;
  variants: number;
  images: number;
  /** Stock figures the payload stated (product + variants); 0 when none. */
  stockFigures: number;
}

interface ProductRow {
  id: string;
  stock: number;
  status: string;
}

interface VariantRow {
  id: string;
  product_id: string;
  stock: number;
}

/**
 * The write half of `cat-008`: one `product.imported` payload → products,
 * variants, images, category/brand references and one stock movement.
 *
 * Everything here runs on the caller's transaction, because the
 * `processed_events` claim, the product write and the stock movement have to
 * commit or vanish together. `ProductsRepository` is deliberately not reused:
 * it is the HTTP path's writer, it owns presentation columns (`photo_settings`,
 * `card_settings`, `tags`, `attributes`) an import must never touch, and `R4`
 * of this wave asks the existing product path to stay byte-for-byte unchanged.
 *
 * **What an import owns here:** sku, name, slug, description, price, stock,
 * status and the category/brand *reference*. What it does not: `source` and
 * `external_id` on an existing row (they record where the row came from and are
 * never rewritten), presentation settings, tags, attributes, discounts, badges,
 * options and `deleted_at`.
 */
@Injectable()
export class ProductImportRepository {
  private readonly logger = new Logger(ProductImportRepository.name);

  async upsert(
    client: PoolClient,
    payload: ProductImportedPayload,
  ): Promise<ImportWriteResult> {
    const categoryId = await this.resolveCategory(client, payload);
    const brandId = await this.resolveBrand(client, payload);

    const product = await this.upsertProduct(client, payload, {
      categoryId,
      brandId,
    });

    let stockFigures = 0;
    let variantCount = 0;

    for (const variant of payload.variants ?? []) {
      if (await this.upsertVariant(client, payload.productId, variant)) {
        stockFigures += 1;
      }
      variantCount += 1;
    }

    const images = await this.replaceImages(
      client,
      payload.productId,
      payload.images ?? (payload.imageUrl ? [payload.imageUrl] : null),
    );

    return {
      productId: payload.productId,
      created: product.created,
      variants: variantCount,
      images,
      stockFigures: stockFigures + (product.stockStated ? 1 : 0),
    };
  }

  /**
   * The product row, keyed by `id` — never upserted "by sku", because the event
   * carries the id and a sku already held by *another* product is a collision a
   * human has to resolve, not something to silently overwrite.
   *
   * `stock` is written as `imported − openReserved`, never as the raw figure:
   * see `upsertProductStock`.
   */
  private async upsertProduct(
    client: PoolClient,
    payload: ProductImportedPayload,
    refs: { categoryId: string | null; brandId: string | null },
  ): Promise<{ created: boolean; stockStated: boolean }> {
    const existing = await client.query<ProductRow>(
      `SELECT id, stock, status FROM catalog.products WHERE id = $1 FOR UPDATE`,
      [payload.productId],
    );
    const current = existing.rows[0];
    const status = nextStatus(payload.status, current?.status);

    if (!current) {
      const onHand = await this.stockFor(
        client,
        payload.productId,
        null,
        payload.stock,
      );

      await this.guardUniqueProductKeys(client, payload);

      await client.query(
        `INSERT INTO catalog.products (
           id, sku, name, slug, description, category_id, brand_id,
           price, stock, status, source
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'import')`,
        [
          payload.productId,
          payload.sku,
          payload.name,
          payload.slug,
          payload.description ?? null,
          refs.categoryId,
          refs.brandId,
          payload.price,
          onHand.written ?? 0,
          status,
        ],
      );

      await this.recordImportMovement(
        client,
        payload.productId,
        null,
        0,
        onHand.written,
      );

      return { created: true, stockStated: onHand.written !== null };
    }

    const onHand = await this.stockFor(
      client,
      payload.productId,
      null,
      payload.stock,
    );

    await this.guardUniqueProductKeys(client, payload);

    // `source`, `external_id`, `photo_settings`, `card_settings`, `tags` and
    // `attributes` are absent from the SET list on purpose: an import states
    // what a product *is*, not how it looks or where it came from.
    await client.query(
      `UPDATE catalog.products
          SET sku = $2,
              name = $3,
              slug = $4,
              description = $5,
              category_id = $6,
              brand_id = $7,
              price = $8,
              stock = COALESCE($9, stock),
              status = $10,
              updated_at = now()
        WHERE id = $1`,
      [
        payload.productId,
        payload.sku,
        payload.name,
        payload.slug,
        payload.description ?? null,
        refs.categoryId,
        refs.brandId,
        payload.price,
        onHand.written,
        status,
      ],
    );

    await this.recordImportMovement(
      client,
      payload.productId,
      null,
      current.stock,
      onHand.written,
    );

    return { created: false, stockStated: onHand.written !== null };
  }

  /**
   * One sellable variant, upserted by `sku`.
   *
   * A `sku` held by a *different* product is `variant-sku-conflict`: rewriting
   * its `product_id` would move a live cart line to another product, and
   * ignoring it would silently drop half the import.
   *
   * Variants are never deleted for being absent from the payload. Absence is
   * ambiguous — "the feed stopped selling it", "the feed omitted the array", "a
   * partial import" — and a deleted variant takes its stock movement history
   * with it (`ON DELETE CASCADE`). Withdrawal is a human decision.
   *
   * Resolves `true` when the variant stated a stock figure, which is what the
   * caller counts for its log line.
   */
  private async upsertVariant(
    client: PoolClient,
    productId: string,
    variant: ProductVariantRef,
  ): Promise<boolean> {
    const existing = await client.query<VariantRow>(
      `SELECT id, product_id, stock
         FROM catalog.product_variants
        WHERE sku = $1
        FOR UPDATE`,
      [variant.sku],
    );
    const current = existing.rows[0];

    if (current && current.product_id !== productId) {
      throw new ProductImportRejectedError(
        'variant-sku-conflict',
        `Variant sku ${variant.sku} already belongs to product ${current.product_id}`,
      );
    }

    const onHand = await this.stockFor(
      client,
      productId,
      current?.id ?? null,
      variant.stock,
    );

    if (current) {
      await client.query(
        `UPDATE catalog.product_variants
            SET price = $2,
                stock = COALESCE($3, stock),
                image_url = COALESCE($4, image_url),
                is_active = COALESCE($5, is_active),
                updated_at = now()
          WHERE id = $1`,
        [
          current.id,
          variant.price,
          onHand.written,
          variant.imageUrl ?? null,
          variant.isActive ?? null,
        ],
      );

      await this.recordImportMovement(
        client,
        productId,
        current.id,
        current.stock,
        onHand.written,
      );

      return onHand.written !== null;
    }

    const created = await client.query<{ id: string }>(
      `INSERT INTO catalog.product_variants (
         product_id, sku, price, stock, image_url, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        productId,
        variant.sku,
        variant.price,
        onHand.written ?? 0,
        variant.imageUrl ?? null,
        variant.isActive ?? true,
      ],
    );

    await this.recordImportMovement(
      client,
      productId,
      created.rows[0].id,
      0,
      onHand.written,
    );

    return onHand.written !== null;
  }

  /**
   * **The money rule.**
   *
   * `products.stock` / `product_variants.stock` are *on hand already net of
   * holds*: `StockReservationsRepository.reserve` decrements them the moment a
   * hold is taken and writes a `sale` movement. A feed, though, reports
   * *physical* stock — the units on the shelf, including the ones a shopper is
   * holding. So the write is:
   *
   * ```text
   * onHand = max(0, imported − openReserved)
   * ```
   *
   * `openReserved` counts every `held` reservation, **including ones past their
   * expiry that the sweeper has not reached yet**: those units are still
   * deducted from `stock` and are about to be given back, so subtracting them
   * now is what stops the sweep from double-counting them later.
   *
   * Clamping at zero is the honest failure: a feed that reports fewer units than
   * live holds is wrong, but refusing the whole import over it would leave the
   * product unpriced and unbuyable. The clamp is logged as a warning with both
   * numbers, so the discrepancy is visible without a schema change.
   *
   * Returns `written: null` when the payload does not carry `stock` at all —
   * "the feed did not say" must never mean "set it to zero".
   */
  private async stockFor(
    client: PoolClient,
    productId: string,
    variantId: string | null,
    imported: number | undefined,
  ): Promise<{ written: number | null }> {
    if (imported === undefined) {
      return { written: null };
    }

    const reserved = variantId
      ? await this.openReservedForVariant(client, productId, variantId)
      : await this.openReservedForProduct(client, productId);
    const onHand = Math.max(0, imported - reserved);

    if (imported < reserved) {
      this.logger.warn(
        `Import reports ${imported} units for ${variantId ? `variant ${variantId}` : `product ${productId}`} but ${reserved} are held; clamping on-hand stock to 0`,
      );
    }

    return { written: onHand };
  }

  /** Held units for the product itself (holds without a variant). */
  private async openReservedForProduct(
    client: PoolClient,
    productId: string,
  ): Promise<number> {
    const { rows } = await client.query<{ reserved: number }>(
      `SELECT COALESCE(SUM((item ->> 'quantity')::int), 0)::int AS reserved
         FROM catalog.stock_reservations r
         CROSS JOIN LATERAL jsonb_array_elements(r.items) AS item
        WHERE r.status = 'held'
          AND item ->> 'productId' = $1
          AND COALESCE(item ->> 'variantId', '') = ''`,
      [productId],
    );

    return rows[0]?.reserved ?? 0;
  }

  /** Held units for one variant. */
  private async openReservedForVariant(
    client: PoolClient,
    productId: string,
    variantId: string,
  ): Promise<number> {
    const { rows } = await client.query<{ reserved: number }>(
      `SELECT COALESCE(SUM((item ->> 'quantity')::int), 0)::int AS reserved
         FROM catalog.stock_reservations r
         CROSS JOIN LATERAL jsonb_array_elements(r.items) AS item
        WHERE r.status = 'held'
          AND item ->> 'productId' = $1
          AND item ->> 'variantId' = $2`,
      [productId, variantId],
    );

    return rows[0]?.reserved ?? 0;
  }

  /**
   * Writes the audit row for a stock figure the import stated.
   *
   * `reason = 'import'` was already a legal value in `stock_movements`' CHECK
   * (001), so this needs no migration. Exactly one row per figure the payload
   * carries — never one per write attempt — and the row is written even when
   * `qty_change` is `0`, because what it records is "the feed asserted this
   * number for this row" (and what the clamp below turned it into). A redelivery
   * cannot add a second one: the `processed_events` claim dedupes the event.
   */
  private async recordImportMovement(
    client: PoolClient,
    productId: string,
    variantId: string | null,
    previousStock: number,
    written: number | null,
  ): Promise<void> {
    if (written === null) {
      return;
    }

    await client.query(
      `INSERT INTO catalog.stock_movements (
         product_id, variant_id, qty_change, reason, qty_after
       ) VALUES ($1, $2, $3, 'import', $4)`,
      [productId, variantId, written - previousStock, written],
    );
  }

  /**
   * Replaces the product-level image set with the payload's.
   *
   * Three steps, in this order, because `one_primary_per_product` is a partial
   * unique index on `(product_id) WHERE is_primary`:
   *
   * 1. clear the old primary (if it is not the incoming primary) — inserting the
   *    new one first would violate the index;
   * 2. delete the rows whose url is no longer in the payload;
   * 3. upsert each remaining url with `sort_order` = its array index and
   *    `is_primary` = `index === 0`.
   *
   * Variant images are untouched: `imageRefSchema` is a bare string, so a
   * payload cannot say which variant an image belongs to.
   *
   * `null` means "the payload said nothing about images" and leaves the set
   * alone; `[]` means "this product has no images" and clears it.
   */
  private async replaceImages(
    client: PoolClient,
    productId: string,
    incoming: string[] | null,
  ): Promise<number> {
    if (incoming === null) {
      return 0;
    }

    // Deduplicated in first-seen order: two rows sharing a url could both be
    // marked primary, which the partial unique index refuses.
    const urls = [...new Set(incoming)];

    await client.query(
      `UPDATE catalog.product_images
          SET is_primary = false
        WHERE product_id = $1 AND variant_id IS NULL AND is_primary
          AND url IS DISTINCT FROM $2`,
      [productId, urls[0] ?? null],
    );

    await client.query(
      `DELETE FROM catalog.product_images
        WHERE product_id = $1 AND variant_id IS NULL
          AND url <> ALL($2::varchar[])`,
      [productId, urls],
    );

    for (const [index, url] of urls.entries()) {
      const updated = await client.query(
        `UPDATE catalog.product_images
            SET sort_order = $3, is_primary = $4
          WHERE product_id = $1 AND variant_id IS NULL AND url = $2`,
        [productId, url, index, index === 0],
      );

      if ((updated.rowCount ?? 0) === 0) {
        await client.query(
          `INSERT INTO catalog.product_images (
             product_id, url, sort_order, is_primary
           ) VALUES ($1, $2, $3, $4)`,
          [productId, url, index, index === 0],
        );
      }
    }

    return urls.length;
  }

  /**
   * A category is referenced either by id (must exist) or by slug (found, or
   * created active). Creating a category from an import is intentional: a feed
   * that names a category the catalog does not have yet must not be dead-lettered
   * for it.
   *
   * Existence is checked without a `deleted_at` filter: a soft-deleted category
   * still exists as a row, and the foreign key would accept it either way.
   */
  private async resolveCategory(
    client: PoolClient,
    payload: ProductImportedPayload,
  ): Promise<string | null> {
    if (payload.categoryId) {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM catalog.categories WHERE id = $1`,
        [payload.categoryId],
      );
      if (!found.rows[0]) {
        throw new ProductImportRejectedError(
          'unresolved-reference',
          `Category ${payload.categoryId} does not exist`,
        );
      }
      return found.rows[0].id;
    }

    if (payload.categorySlug) {
      const slug = slugify(payload.categorySlug);
      return this.findOrCreate(client, 'catalog.categories', {
        name: payload.categorySlug,
        slug,
      });
    }

    return null;
  }

  /** Same rule as `resolveCategory`, with the brand's own slugification. */
  private async resolveBrand(
    client: PoolClient,
    payload: ProductImportedPayload,
  ): Promise<string | null> {
    if (payload.brandId) {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM catalog.brands WHERE id = $1`,
        [payload.brandId],
      );
      if (!found.rows[0]) {
        throw new ProductImportRejectedError(
          'unresolved-reference',
          `Brand ${payload.brandId} does not exist`,
        );
      }
      return found.rows[0].id;
    }

    if (payload.brandName) {
      const slug = slugify(payload.brandName);
      return this.findOrCreate(client, 'catalog.brands', {
        name: payload.brandName,
        slug,
      });
    }

    return null;
  }

  /**
   * `INSERT … ON CONFLICT DO NOTHING` plus a re-read, so two concurrent imports
   * that both create the same brand end up sharing one row instead of raising.
   */
  private async findOrCreate(
    client: PoolClient,
    table: 'catalog.categories' | 'catalog.brands',
    values: { name: string; slug: string },
  ): Promise<string> {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE slug = $1`,
      [values.slug],
    );
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }

    const created = await client.query<{ id: string }>(
      `INSERT INTO ${table} (name, slug, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [values.name, values.slug],
    );
    if (created.rows[0]) {
      return created.rows[0].id;
    }

    const raced = await client.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE slug = $1`,
      [values.slug],
    );

    if (!raced.rows[0]) {
      // Unreachable unless the row was deleted between the two statements.
      throw new ProductImportRejectedError(
        'unresolved-reference',
        `Could not resolve or create ${table} slug ${values.slug}`,
      );
    }

    return raced.rows[0].id;
  }

  /**
   * A sku or slug held by a *different* product is a conflict, and the message
   * has to say which one so the operator opening `product.imported.dlq` knows
   * what to fix.
   *
   * Checked explicitly rather than caught from the unique violation so the
   * error names the constraint that fired, and so both keys are checked before
   * either is written.
   */
  private async guardUniqueProductKeys(
    client: PoolClient,
    payload: ProductImportedPayload,
  ): Promise<void> {
    const sku = await client.query<{ id: string }>(
      `SELECT id FROM catalog.products WHERE sku = $1 AND id <> $2`,
      [payload.sku, payload.productId],
    );
    if (sku.rows[0]) {
      throw new ProductImportRejectedError(
        'sku-conflict',
        `Sku ${payload.sku} already belongs to product ${sku.rows[0].id}`,
      );
    }

    const slug = await client.query<{ id: string }>(
      `SELECT id FROM catalog.products WHERE slug = $1 AND id <> $2`,
      [payload.slug, payload.productId],
    );
    if (slug.rows[0]) {
      throw new ProductImportRejectedError(
        'slug-conflict',
        `Slug ${payload.slug} already belongs to product ${slug.rows[0].id}`,
      );
    }
  }
}

/**
 * The payload's two states onto the table's three.
 *
 * `inactive` becomes `draft` — "not currently sellable" — which is the closest
 * of the three. It never lifts an `archived` row back to `draft`: withdrawing a
 * product is a local decision, and only an explicit `active` in a later event
 * may undo it.
 */
function nextStatus(
  incoming: ProductImportedPayload['status'],
  current: string | undefined,
): 'active' | 'draft' | 'archived' {
  if (incoming === 'active') {
    return 'active';
  }

  return current === 'archived' ? 'archived' : 'draft';
}

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { getPool } from '../db/pool.js';
import { computeEffectivePrice } from '../products/products.types.js';
import type {
  CatalogProductSnapshot,
  StockLevel,
  StockMovement,
  StockMovementReason,
} from './inventory.types.js';

interface StockMovementRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  qty_change: number;
  reason: string;
  order_id: string | null;
  qty_after: number;
  created_at: Date;
}

interface ProductSnapshotRow {
  variant_id: string | null;
  product_id: string;
  product_name: string;
  product_slug: string;
  sku: string;
  image_url: string | null;
  variant_label: string | null;
  unit_price: string | number;
  stock: number;
  is_valid: boolean;
  discount_type: string | null;
  discount_value: string | number | null;
}

@Injectable()
export class InventoryRepository {
  private get pool(): Pool {
    return getPool();
  }

  private mapMovement(row: StockMovementRow): StockMovement {
    return {
      id: row.id,
      productId: row.product_id,
      variantId: row.variant_id,
      qtyChange: row.qty_change,
      reason: row.reason as StockMovementReason,
      orderId: row.order_id,
      qtyAfter: row.qty_after,
      createdAt: row.created_at.toISOString(),
    };
  }

  async getStock(
    productId: string,
    variantId?: string | null,
  ): Promise<StockLevel | null> {
    if (variantId) {
      const res = await this.pool.query<{
        variant_id: string;
        product_id: string;
        sku: string;
        stock: number;
      }>(
        `SELECT pv.id AS variant_id, pv.product_id, pv.sku, pv.stock
           FROM catalog.product_variants pv
          WHERE pv.id = $1 AND pv.product_id = $2`,
        [variantId, productId],
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      return {
        productId: row.product_id,
        variantId: row.variant_id,
        sku: row.sku,
        stock: row.stock,
        available: row.stock > 0,
      };
    }

    const res = await this.pool.query<{
      product_id: string;
      sku: string;
      stock: number;
    }>(
      `SELECT p.id AS product_id, p.sku, p.stock
         FROM catalog.products p
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [productId],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      productId: row.product_id,
      variantId: null,
      sku: row.sku,
      stock: row.stock,
      available: row.stock > 0,
    };
  }

  async adjustStock(
    productId: string,
    variantId: string | null | undefined,
    delta: number,
    reason: StockMovementReason = 'admin_adjustment',
    orderId?: string | null,
  ): Promise<{ stock: number; movement: StockMovement }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let currentStock = 0;

      if (variantId) {
        const checkRes = await client.query<{ stock: number }>(
          `SELECT stock FROM catalog.product_variants
            WHERE id = $1 AND product_id = $2 FOR UPDATE`,
          [variantId, productId],
        );
        if (checkRes.rows.length === 0) {
          throw new NotFoundException(
            `Variant ${variantId} for product ${productId} not found`,
          );
        }
        currentStock = checkRes.rows[0].stock;
      } else {
        const checkRes = await client.query<{ stock: number }>(
          `SELECT stock FROM catalog.products
            WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [productId],
        );
        if (checkRes.rows.length === 0) {
          throw new NotFoundException(`Product ${productId} not found`);
        }
        currentStock = checkRes.rows[0].stock;
      }

      const newStock = currentStock + delta;
      if (newStock < 0) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          message: `Stock cannot fall below zero. Current stock: ${currentStock}, adjustment: ${delta}`,
        });
      }

      if (variantId) {
        await client.query(
          `UPDATE catalog.product_variants
              SET stock = $1, updated_at = now()
            WHERE id = $2`,
          [newStock, variantId],
        );
      } else {
        await client.query(
          `UPDATE catalog.products
              SET stock = $1, updated_at = now()
            WHERE id = $2`,
          [newStock, productId],
        );
      }

      const movementRes = await client.query<StockMovementRow>(
        `INSERT INTO catalog.stock_movements (
           product_id, variant_id, qty_change, reason, order_id, qty_after
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, product_id, variant_id, qty_change, reason, order_id, qty_after, created_at`,
        [
          productId,
          variantId ?? null,
          delta,
          reason,
          orderId ?? null,
          newStock,
        ],
      );

      await client.query('COMMIT');
      return {
        stock: newStock,
        movement: this.mapMovement(movementRes.rows[0]),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getStockMovements(
    productId: string,
    cursor?: string,
    limit = 20,
  ): Promise<{ data: StockMovement[]; nextCursor: string | null }> {
    let cursorDate: Date | null = null;
    let cursorId: string | null = null;

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const [timeStr, idStr] = decoded.split('|');
        if (timeStr && idStr) {
          cursorDate = new Date(timeStr);
          cursorId = idStr;
        }
      } catch {
        // ignore invalid cursor
      }
    }

    const query = `
      SELECT id, product_id, variant_id, qty_change, reason, order_id, qty_after, created_at
        FROM catalog.stock_movements
       WHERE product_id = $1
         AND (
           $2::timestamptz IS NULL
           OR created_at < $2::timestamptz
           OR (created_at = $2::timestamptz AND id < $3::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT $4
    `;

    const res = await this.pool.query<StockMovementRow>(query, [
      productId,
      cursorDate,
      cursorId,
      limit + 1,
    ]);

    const hasMore = res.rows.length > limit;
    const rows = hasMore ? res.rows.slice(0, limit) : res.rows;

    let nextCursor: string | null = null;
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1];
      nextCursor = Buffer.from(
        `${last.created_at.toISOString()}|${last.id}`,
      ).toString('base64url');
    }

    return {
      data: rows.map((r) => this.mapMovement(r)),
      nextCursor,
    };
  }

  async getProductSnapshots(ids: string[]): Promise<CatalogProductSnapshot[]> {
    if (ids.length === 0) return [];

    const query = `
      WITH requested_ids AS (
        SELECT unnest($1::uuid[]) AS id
      ),
      matched_variants AS (
        SELECT
          pv.id AS variant_id,
          p.id AS product_id,
          p.name AS product_name,
          p.slug AS product_slug,
          pv.sku AS sku,
          COALESCE(pv.image_url, pi.url) AS image_url,
          (
            SELECT string_agg(po.name || ': ' || pov.value, ' / ' ORDER BY po.position ASC)
              FROM catalog.product_variant_option_values pvov
              JOIN catalog.product_options po ON po.id = pvov.option_id
              JOIN catalog.product_option_values pov ON pov.id = pvov.option_value_id
             WHERE pvov.variant_id = pv.id
          ) AS variant_label,
          pv.price AS unit_price,
          pv.stock AS stock,
          pv.is_active AND p.status = 'active' AND p.deleted_at IS NULL AS is_valid,
          pd.discount_type,
          pd.value AS discount_value
        FROM catalog.product_variants pv
        JOIN catalog.products p ON p.id = pv.product_id
        LEFT JOIN catalog.product_images pi ON pi.product_id = p.id AND pi.is_primary = true
        LEFT JOIN LATERAL (
          SELECT discount_type, value
            FROM catalog.product_discounts
           WHERE product_id = p.id
             AND is_active = true
             AND starts_at <= now()
             AND ends_at >= now()
           ORDER BY created_at DESC
           LIMIT 1
        ) pd ON true
        WHERE pv.id IN (SELECT id FROM requested_ids)
      ),
      matched_products AS (
        SELECT
          NULL::uuid AS variant_id,
          p.id AS product_id,
          p.name AS product_name,
          p.slug AS product_slug,
          p.sku AS sku,
          pi.url AS image_url,
          NULL::text AS variant_label,
          p.price AS unit_price,
          p.stock AS stock,
          p.status = 'active' AND p.deleted_at IS NULL AS is_valid,
          pd.discount_type,
          pd.value AS discount_value
        FROM catalog.products p
        LEFT JOIN catalog.product_images pi ON pi.product_id = p.id AND pi.is_primary = true
        LEFT JOIN LATERAL (
          SELECT discount_type, value
            FROM catalog.product_discounts
           WHERE product_id = p.id
             AND is_active = true
             AND starts_at <= now()
             AND ends_at >= now()
           ORDER BY created_at DESC
           LIMIT 1
        ) pd ON true
        WHERE p.id IN (SELECT id FROM requested_ids)
          AND p.id NOT IN (SELECT product_id FROM matched_variants)
      )
      SELECT * FROM matched_variants
      UNION ALL
      SELECT * FROM matched_products;
    `;

    const res = await this.pool.query<ProductSnapshotRow>(query, [ids]);

    return res.rows.map((row) => {
      const unitPrice = Number(row.unit_price);
      let effectivePrice = unitPrice;

      if (row.discount_type && row.discount_value !== null) {
        effectivePrice = computeEffectivePrice(unitPrice, {
          discountType: row.discount_type as 'percent' | 'fixed',
          value: Number(row.discount_value),
        });
      }

      return {
        productId: row.product_id,
        variantId: row.variant_id,
        productName: row.product_name,
        productSlug: row.product_slug,
        sku: row.sku,
        imageUrl: row.image_url,
        variantLabel: row.variant_label,
        unitPrice,
        effectivePrice,
        stock: row.stock,
        available: row.is_valid && row.stock > 0,
      };
    });
  }
}

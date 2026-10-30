import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool.js';
import {
  Badge,
  BadgeRow,
  mapBadgeRow,
  ProductBadgeItem,
  ProductBadgeRow,
} from './badges.types.js';
import { CreateBadgeDto } from './dto/create-badge.dto.js';
import { ProductBadgeAssignmentItemDto } from './dto/assign-product-badges.dto.js';
import { UpdateBadgeDto } from './dto/update-badge.dto.js';

@Injectable()
export class BadgesRepository {
  async findAll(options: { activeOnly?: boolean } = {}): Promise<Badge[]> {
    const pool = getPool();
    const condition = options.activeOnly === true ? 'WHERE is_active = true' : '';

    const { rows } = await pool.query<BadgeRow>(
      `SELECT id, key, label, bg, text_color, border_color, border_style, is_active, created_at, updated_at
       FROM catalog.badges
       ${condition}
       ORDER BY label ASC;`,
    );

    return rows.map(mapBadgeRow);
  }

  async findById(id: string): Promise<Badge | null> {
    const pool = getPool();
    const { rows } = await pool.query<BadgeRow>(
      `SELECT id, key, label, bg, text_color, border_color, border_style, is_active, created_at, updated_at
       FROM catalog.badges
       WHERE id = $1;`,
      [id],
    );

    if (rows.length === 0) return null;
    return mapBadgeRow(rows[0]);
  }

  async findByKey(key: string): Promise<Badge | null> {
    const pool = getPool();
    const { rows } = await pool.query<BadgeRow>(
      `SELECT id, key, label, bg, text_color, border_color, border_style, is_active, created_at, updated_at
       FROM catalog.badges
       WHERE key = $1;`,
      [key],
    );

    if (rows.length === 0) return null;
    return mapBadgeRow(rows[0]);
  }

  async create(dto: CreateBadgeDto): Promise<Badge> {
    const pool = getPool();
    const { rows } = await pool.query<BadgeRow>(
      `INSERT INTO catalog.badges (
         key, label, bg, text_color, border_color, border_style, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, key, label, bg, text_color, border_color, border_style, is_active, created_at, updated_at;`,
      [
        dto.key,
        dto.label,
        dto.bg,
        dto.textColor,
        dto.borderColor ?? null,
        dto.borderStyle ?? 'solid',
        dto.isActive ?? true,
      ],
    );

    return mapBadgeRow(rows[0]);
  }

  async update(id: string, dto: UpdateBadgeDto): Promise<Badge | null> {
    const pool = getPool();
    const updates: string[] = [];
    const values: unknown[] = [id];
    let paramIndex = 2;

    if (dto.key !== undefined) {
      updates.push(`key = $${paramIndex++}`);
      values.push(dto.key);
    }
    if (dto.label !== undefined) {
      updates.push(`label = $${paramIndex++}`);
      values.push(dto.label);
    }
    if (dto.bg !== undefined) {
      updates.push(`bg = $${paramIndex++}`);
      values.push(dto.bg);
    }
    if (dto.textColor !== undefined) {
      updates.push(`text_color = $${paramIndex++}`);
      values.push(dto.textColor);
    }
    if (dto.borderColor !== undefined) {
      updates.push(`border_color = $${paramIndex++}`);
      values.push(dto.borderColor);
    }
    if (dto.borderStyle !== undefined) {
      updates.push(`border_style = $${paramIndex++}`);
      values.push(dto.borderStyle);
    }
    if (dto.isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(dto.isActive);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    const { rows } = await pool.query<BadgeRow>(
      `UPDATE catalog.badges
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING id, key, label, bg, text_color, border_color, border_style, is_active, created_at, updated_at;`,
      values,
    );

    if (rows.length === 0) return null;
    return mapBadgeRow(rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const pool = getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM catalog.badges WHERE id = $1;`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async getProductBadges(
    productId: string,
    options: { activeOnly?: boolean } = { activeOnly: true },
  ): Promise<ProductBadgeItem[]> {
    const pool = getPool();
    const activeCondition = options.activeOnly
      ? `AND b.is_active = true
         AND (pb.starts_at IS NULL OR pb.starts_at <= now())
         AND (pb.ends_at IS NULL OR pb.ends_at >= now())`
      : '';

    const { rows } = await pool.query<ProductBadgeRow>(
      `SELECT b.id, b.key, b.label, b.bg, b.text_color, b.border_color, b.border_style, pb.sort_order
       FROM catalog.product_badges pb
       JOIN catalog.badges b ON pb.badge_id = b.id
       WHERE pb.product_id = $1 ${activeCondition}
       ORDER BY pb.sort_order ASC, pb.created_at ASC;`,
      [productId],
    );

    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label,
      bg: r.bg,
      textColor: r.text_color,
      borderColor: r.border_color ?? undefined,
      borderStyle: r.border_style,
      sortOrder: r.sort_order,
    }));
  }

  async assignProductBadges(
    productId: string,
    assignments: ProductBadgeAssignmentItemDto[],
  ): Promise<ProductBadgeItem[]> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM catalog.product_badges WHERE product_id = $1;`,
        [productId],
      );

      for (let i = 0; i < assignments.length; i++) {
        const item = assignments[i];
        await client.query(
          `INSERT INTO catalog.product_badges (product_id, badge_id, sort_order, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5);`,
          [
            productId,
            item.badgeId,
            item.sortOrder ?? i,
            item.startsAt ? new Date(item.startsAt) : null,
            item.endsAt ? new Date(item.endsAt) : null,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return this.getProductBadges(productId, { activeOnly: false });
  }
}

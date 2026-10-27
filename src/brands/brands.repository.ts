import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool.js';
import { Brand, BrandRow, mapBrandRow } from './brands.types.js';
import { CreateBrandDto } from './dto/create-brand.dto.js';
import { UpdateBrandDto } from './dto/update-brand.dto.js';

@Injectable()
export class BrandsRepository {
  async findAll(options: { activeOnly?: boolean } = {}): Promise<Brand[]> {
    const pool = getPool();
    const activeCondition =
      options.activeOnly === true ? 'AND is_active = true' : '';

    const { rows } = await pool.query<BrandRow>(
      `SELECT id, name, slug, logo_url, description, is_active, sort_order, created_at, updated_at
       FROM catalog.brands
       WHERE deleted_at IS NULL ${activeCondition}
       ORDER BY sort_order ASC, name ASC;`,
    );

    return rows.map(mapBrandRow);
  }

  async findBySlug(slug: string): Promise<Brand | null> {
    const pool = getPool();
    const { rows } = await pool.query<BrandRow>(
      `SELECT id, name, slug, logo_url, description, is_active, sort_order, created_at, updated_at
       FROM catalog.brands
       WHERE slug = $1 AND deleted_at IS NULL;`,
      [slug],
    );

    if (rows.length === 0) {
      return null;
    }

    return mapBrandRow(rows[0]);
  }

  async findById(id: string): Promise<Brand | null> {
    const pool = getPool();
    const { rows } = await pool.query<BrandRow>(
      `SELECT id, name, slug, logo_url, description, is_active, sort_order, created_at, updated_at
       FROM catalog.brands
       WHERE id = $1 AND deleted_at IS NULL;`,
      [id],
    );

    if (rows.length === 0) {
      return null;
    }

    return mapBrandRow(rows[0]);
  }

  async create(dto: CreateBrandDto & { slug: string }): Promise<Brand> {
    const pool = getPool();
    const { rows } = await pool.query<BrandRow>(
      `INSERT INTO catalog.brands (
         name, slug, logo_url, description, is_active, sort_order
       ) VALUES (
         $1, $2, $3, $4, $5, $6
       )
       RETURNING id, name, slug, logo_url, description, is_active, sort_order, created_at, updated_at;`,
      [
        dto.name,
        dto.slug,
        dto.logoUrl ?? null,
        dto.description ?? null,
        dto.isActive ?? true,
        dto.sortOrder ?? 0,
      ],
    );

    return mapBrandRow(rows[0]);
  }

  async update(id: string, dto: UpdateBrandDto): Promise<Brand | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (dto.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(dto.name);
    }
    if (dto.slug !== undefined) {
      fields.push(`slug = $${idx++}`);
      values.push(dto.slug);
    }
    if (dto.logoUrl !== undefined) {
      fields.push(`logo_url = $${idx++}`);
      values.push(dto.logoUrl);
    }
    if (dto.description !== undefined) {
      fields.push(`description = $${idx++}`);
      values.push(dto.description);
    }
    if (dto.isActive !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(dto.isActive);
    }
    if (dto.sortOrder !== undefined) {
      fields.push(`sort_order = $${idx++}`);
      values.push(dto.sortOrder);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const pool = getPool();
    const { rows } = await pool.query<BrandRow>(
      `UPDATE catalog.brands
       SET ${fields.join(', ')}
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING id, name, slug, logo_url, description, is_active, sort_order, created_at, updated_at;`,
      values,
    );

    if (rows.length === 0) {
      return null;
    }

    return mapBrandRow(rows[0]);
  }

  async softDelete(id: string): Promise<boolean> {
    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE catalog.brands
       SET deleted_at = now(), is_active = false
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id;`,
      [id],
    );

    return rows.length > 0;
  }
}

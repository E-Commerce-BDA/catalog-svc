import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool.js';
import {
  Category,
  CategoryRow,
  mapCategoryRow,
} from './categories.types.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

@Injectable()
export class CategoriesRepository {
  async findNavbar(): Promise<Category[]> {
    const pool = getPool();
    const { rows } = await pool.query<CategoryRow>(
      `SELECT id, parent_id, name, slug, description, image_url, is_active,
              show_in_navbar, show_in_megamenu, megamenu_show_images, sort_order,
              settings, created_at, updated_at
       FROM catalog.categories
       WHERE is_active = true AND show_in_navbar = true AND deleted_at IS NULL
       ORDER BY sort_order ASC, name ASC;`,
    );

    return rows.map(mapCategoryRow);
  }

  async findAll(options: { activeOnly?: boolean } = {}): Promise<Category[]> {
    const pool = getPool();
    const activeCondition =
      options.activeOnly === true ? 'AND is_active = true' : '';

    const { rows } = await pool.query<CategoryRow>(
      `SELECT id, parent_id, name, slug, description, image_url, is_active,
              show_in_navbar, show_in_megamenu, megamenu_show_images, sort_order,
              settings, created_at, updated_at
       FROM catalog.categories
       WHERE deleted_at IS NULL ${activeCondition}
       ORDER BY sort_order ASC, name ASC;`,
    );

    return rows.map(mapCategoryRow);
  }

  async findBySlug(slug: string): Promise<Category | null> {
    const pool = getPool();
    const { rows } = await pool.query<CategoryRow>(
      `SELECT id, parent_id, name, slug, description, image_url, is_active,
              show_in_navbar, show_in_megamenu, megamenu_show_images, sort_order,
              settings, created_at, updated_at
       FROM catalog.categories
       WHERE slug = $1 AND deleted_at IS NULL;`,
      [slug],
    );

    if (rows.length === 0) {
      return null;
    }

    return mapCategoryRow(rows[0]);
  }

  async findById(id: string): Promise<Category | null> {
    const pool = getPool();
    const { rows } = await pool.query<CategoryRow>(
      `SELECT id, parent_id, name, slug, description, image_url, is_active,
              show_in_navbar, show_in_megamenu, megamenu_show_images, sort_order,
              settings, created_at, updated_at
       FROM catalog.categories
       WHERE id = $1 AND deleted_at IS NULL;`,
      [id],
    );

    if (rows.length === 0) {
      return null;
    }

    return mapCategoryRow(rows[0]);
  }

  async create(dto: CreateCategoryDto & { slug: string }): Promise<Category> {
    const pool = getPool();
    const { rows } = await pool.query<CategoryRow>(
      `INSERT INTO catalog.categories (
         name, slug, parent_id, description, image_url, is_active,
         show_in_navbar, show_in_megamenu, megamenu_show_images, sort_order, settings
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       )
       RETURNING id, parent_id, name, slug, description, image_url, is_active,
                 show_in_navbar, show_in_megamenu, megamenu_show_images, sort_order,
                 settings, created_at, updated_at;`,
      [
        dto.name,
        dto.slug,
        dto.parentId ?? null,
        dto.description ?? null,
        dto.imageUrl ?? null,
        dto.isActive ?? true,
        dto.showInNavbar ?? false,
        dto.showInMegamenu ?? false,
        dto.megamenuShowImages ?? false,
        dto.sortOrder ?? 0,
        JSON.stringify(dto.settings ?? {}),
      ],
    );

    return mapCategoryRow(rows[0]);
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<Category | null> {
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
    if (dto.parentId !== undefined) {
      fields.push(`parent_id = $${idx++}`);
      values.push(dto.parentId);
    }
    if (dto.description !== undefined) {
      fields.push(`description = $${idx++}`);
      values.push(dto.description);
    }
    if (dto.imageUrl !== undefined) {
      fields.push(`image_url = $${idx++}`);
      values.push(dto.imageUrl);
    }
    if (dto.isActive !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(dto.isActive);
    }
    if (dto.showInNavbar !== undefined) {
      fields.push(`show_in_navbar = $${idx++}`);
      values.push(dto.showInNavbar);
    }
    if (dto.showInMegamenu !== undefined) {
      fields.push(`show_in_megamenu = $${idx++}`);
      values.push(dto.showInMegamenu);
    }
    if (dto.megamenuShowImages !== undefined) {
      fields.push(`megamenu_show_images = $${idx++}`);
      values.push(dto.megamenuShowImages);
    }
    if (dto.sortOrder !== undefined) {
      fields.push(`sort_order = $${idx++}`);
      values.push(dto.sortOrder);
    }
    if (dto.settings !== undefined) {
      fields.push(`settings = $${idx++}`);
      values.push(JSON.stringify(dto.settings));
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const pool = getPool();
    const { rows } = await pool.query<CategoryRow>(
      `UPDATE catalog.categories
       SET ${fields.join(', ')}
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING id, parent_id, name, slug, description, image_url, is_active,
                 show_in_navbar, show_in_megamenu, megamenu_show_images, sort_order,
                 settings, created_at, updated_at;`,
      values,
    );

    if (rows.length === 0) {
      return null;
    }

    return mapCategoryRow(rows[0]);
  }

  async softDelete(id: string): Promise<boolean> {
    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE catalog.categories
       SET deleted_at = now(), is_active = false
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id;`,
      [id],
    );

    return rows.length > 0;
  }
}

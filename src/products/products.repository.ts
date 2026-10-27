import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool.js';
import { CreateDiscountDto } from './dto/create-discount.dto.js';
import { CreateImageDto } from './dto/create-image.dto.js';
import { CreateOptionDto } from './dto/create-option.dto.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { CreateVariantDto } from './dto/create-variant.dto.js';
import { ProductQueryDto } from './dto/product-query.dto.js';
import { UpdateImageDto } from './dto/update-image.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { UpdateVariantDto } from './dto/update-variant.dto.js';
import {
  computeEffectivePrice,
  ProductDetail,
  ProductDiscount,
  ProductImage,
  ProductListItem,
  ProductOption,
  ProductRow,
  ProductVariant,
} from './products.types.js';

interface RawPdpRow {
  id: string;
  sku: string;
  name: string;
  slug: string;
  short_description: string | null;
  description: string | null;
  price: string | number;
  compare_at_price: string | number | null;
  stock: number;
  status: 'draft' | 'active' | 'archived';
  tags: string[] | null;
  attributes: Record<string, unknown>;
  photo_settings: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  category: { id: string; name: string; slug: string } | null;
  brand: { id: string; name: string; slug: string; logoUrl: string | null } | null;
  images: Array<{
    id: string;
    productId: string;
    variantId: string | null;
    url: string;
    alt: string | null;
    sortOrder: number;
    isPrimary: boolean;
    createdAt: string;
  }>;
  options: Array<{
    id: string;
    productId: string;
    name: string;
    position: number;
    values: Array<{
      id: string;
      optionId: string;
      value: string;
      position: number;
    }>;
  }>;
  variants: Array<{
    id: string;
    productId: string;
    sku: string;
    price: string | number;
    stock: number;
    imageUrl: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
    options: Array<{
      optionId: string;
      optionName: string;
      optionValueId: string;
      value: string;
    }>;
  }>;
  active_discount: {
    id: string;
    productId: string;
    discountType: 'percent' | 'fixed';
    value: string | number;
    startsAt: string;
    endsAt: string;
    isActive: boolean;
  } | null;
}

@Injectable()
export class ProductsRepository {
  async findList(
    query: ProductQueryDto,
  ): Promise<{ data: ProductListItem[]; nextCursor: string | null }> {
    const pool = getPool();
    const limit = query.limit ?? 20;
    const conditions: string[] = ['p.deleted_at IS NULL'];
    const values: unknown[] = [];
    let idx = 1;

    if (query.includeInactive !== 'true') {
      conditions.push(`p.status = 'active'`);
    } else if (query.status) {
      conditions.push(`p.status = $${idx++}`);
      values.push(query.status);
    }

    if (query.categoryId) {
      conditions.push(`p.category_id = $${idx++}`);
      values.push(query.categoryId);
    }

    if (query.brandId) {
      conditions.push(`p.brand_id = $${idx++}`);
      values.push(query.brandId);
    }

    if (query.minPrice !== undefined) {
      conditions.push(`p.price >= $${idx++}`);
      values.push(query.minPrice);
    }

    if (query.maxPrice !== undefined) {
      conditions.push(`p.price <= $${idx++}`);
      values.push(query.maxPrice);
    }

    if (query.q && query.q.trim().length > 0) {
      conditions.push(`p.search_vector @@ plainto_tsquery('english', $${idx++})`);
      values.push(query.q.trim());
    }

    if (query.cursor) {
      conditions.push(`p.id > $${idx++}`);
      values.push(query.cursor);
    }

    let orderBy = 'p.created_at DESC, p.id DESC';
    if (query.sort === 'price_asc') {
      orderBy = 'p.price ASC, p.id ASC';
    } else if (query.sort === 'price_desc') {
      orderBy = 'p.price DESC, p.id DESC';
    } else if (query.sort === 'name_asc') {
      orderBy = 'p.name ASC, p.id ASC';
    }

    const sql = `
      SELECT p.id, p.sku, p.name, p.slug, p.short_description, p.price,
             p.compare_at_price, p.stock, p.status, p.tags, p.created_at, p.updated_at,
             p.category_id, c.name AS category_name, c.slug AS category_slug,
             p.brand_id, b.name AS brand_name, b.slug AS brand_slug,
             pi.url AS primary_image_url,
             d.discount_type, d.value AS discount_value
      FROM catalog.products p
      LEFT JOIN catalog.categories c ON c.id = p.category_id
      LEFT JOIN catalog.brands b ON b.id = p.brand_id
      LEFT JOIN catalog.product_images pi ON pi.product_id = p.id AND pi.is_primary = true
      LEFT JOIN LATERAL (
        SELECT discount_type, value
        FROM catalog.product_discounts pd
        WHERE pd.product_id = p.id
          AND pd.is_active = true
          AND pd.starts_at <= now()
          AND pd.ends_at >= now()
        ORDER BY pd.created_at DESC
        LIMIT 1
      ) d ON true
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1};
    `;

    const { rows } = await pool.query<
      ProductRow & {
        discount_type?: 'percent' | 'fixed';
        discount_value?: string | number;
      }
    >(sql, values);

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? sliced[sliced.length - 1].id : null;

    const data: ProductListItem[] = sliced.map((row) => {
      const basePrice = Number(row.price);
      const discount =
        row.discount_type && row.discount_value !== undefined
          ? {
              discountType: row.discount_type,
              value: Number(row.discount_value),
            }
          : null;

      return {
        id: row.id,
        sku: row.sku,
        name: row.name,
        slug: row.slug,
        shortDescription: row.short_description,
        price: basePrice,
        compareAtPrice:
          row.compare_at_price !== null ? Number(row.compare_at_price) : null,
        effectivePrice: computeEffectivePrice(basePrice, discount),
        stock: Number(row.stock),
        status: row.status,
        categoryId: row.category_id,
        categoryName: row.category_name ?? null,
        categorySlug: row.category_slug ?? null,
        brandId: row.brand_id,
        brandName: row.brand_name ?? null,
        brandSlug: row.brand_slug ?? null,
        primaryImageUrl: row.primary_image_url ?? null,
        tags: Array.isArray(row.tags) ? row.tags : [],
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });

    return { data, nextCursor };
  }

  async findDetail(identifier: {
    slug?: string;
    id?: string;
  }): Promise<ProductDetail | null> {
    const pool = getPool();
    const sql = `
      WITH prod AS (
        SELECT p.*,
               c.name AS cat_name, c.slug AS cat_slug,
               b.name AS br_name, b.slug AS br_slug, b.logo_url AS br_logo
        FROM catalog.products p
        LEFT JOIN catalog.categories c ON c.id = p.category_id
        LEFT JOIN catalog.brands b ON b.id = p.brand_id
        WHERE (
          ($1::text IS NOT NULL AND p.slug = $1) OR
          ($2::uuid IS NOT NULL AND p.id = $2)
        ) AND p.deleted_at IS NULL
      )
      SELECT
        prod.id, prod.sku, prod.name, prod.slug, prod.short_description, prod.description,
        prod.price, prod.compare_at_price, prod.stock, prod.status, prod.tags,
        prod.attributes, prod.photo_settings, prod.created_at, prod.updated_at,
        CASE WHEN prod.category_id IS NOT NULL THEN
          jsonb_build_object('id', prod.category_id, 'name', prod.cat_name, 'slug', prod.cat_slug)
        ELSE NULL END AS category,
        CASE WHEN prod.brand_id IS NOT NULL THEN
          jsonb_build_object('id', prod.brand_id, 'name', prod.br_name, 'slug', prod.br_slug, 'logoUrl', prod.br_logo)
        ELSE NULL END AS brand,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', pi.id,
              'productId', pi.product_id,
              'variantId', pi.variant_id,
              'url', pi.url,
              'alt', pi.alt,
              'sortOrder', pi.sort_order,
              'isPrimary', pi.is_primary,
              'createdAt', pi.created_at
            ) ORDER BY pi.sort_order ASC, pi.created_at ASC
          )
          FROM catalog.product_images pi
          WHERE pi.product_id = prod.id
        ), '[]'::json) AS images,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', po.id,
              'productId', po.product_id,
              'name', po.name,
              'position', po.position,
              'values', COALESCE((
                SELECT json_agg(
                  json_build_object(
                    'id', pov.id,
                    'optionId', pov.option_id,
                    'value', pov.value,
                    'position', pov.position
                  ) ORDER BY pov.position ASC, pov.id ASC
                )
                FROM catalog.product_option_values pov
                WHERE pov.option_id = po.id
              ), '[]'::json)
            ) ORDER BY po.position ASC, po.id ASC
          )
          FROM catalog.product_options po
          WHERE po.product_id = prod.id
        ), '[]'::json) AS options,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', pv.id,
              'productId', pv.product_id,
              'sku', pv.sku,
              'price', pv.price,
              'stock', pv.stock,
              'imageUrl', pv.image_url,
              'isActive', pv.is_active,
              'createdAt', pv.created_at,
              'updatedAt', pv.updated_at,
              'options', COALESCE((
                SELECT json_agg(
                  json_build_object(
                    'optionId', pvov.option_id,
                    'optionName', o.name,
                    'optionValueId', pvov.option_value_id,
                    'value', ov.value
                  )
                )
                FROM catalog.product_variant_option_values pvov
                JOIN catalog.product_options o ON o.id = pvov.option_id
                JOIN catalog.product_option_values ov ON ov.id = pvov.option_value_id
                WHERE pvov.variant_id = pv.id
              ), '[]'::json)
            ) ORDER BY pv.sku ASC
          )
          FROM catalog.product_variants pv
          WHERE pv.product_id = prod.id
        ), '[]'::json) AS variants,
        (
          SELECT json_build_object(
            'id', pd.id,
            'productId', pd.product_id,
            'discountType', pd.discount_type,
            'value', pd.value,
            'startsAt', pd.starts_at,
            'endsAt', pd.ends_at,
            'isActive', pd.is_active
          )
          FROM catalog.product_discounts pd
          WHERE pd.product_id = prod.id
            AND pd.is_active = true
            AND pd.starts_at <= now()
            AND pd.ends_at >= now()
          ORDER BY pd.created_at DESC
          LIMIT 1
        ) AS active_discount
      FROM prod;
    `;

    const { rows } = await pool.query<RawPdpRow>(sql, [
      identifier.slug ?? null,
      identifier.id ?? null,
    ]);

    if (rows.length === 0) {
      return null;
    }

    const raw = rows[0];
    const basePrice = Number(raw.price);
    const activeDiscount: ProductDiscount | null = raw.active_discount
      ? {
          id: raw.active_discount.id,
          productId: raw.active_discount.productId,
          discountType: raw.active_discount.discountType,
          value: Number(raw.active_discount.value),
          startsAt: new Date(raw.active_discount.startsAt).toISOString(),
          endsAt: new Date(raw.active_discount.endsAt).toISOString(),
          isActive: Boolean(raw.active_discount.isActive),
        }
      : null;

    return {
      id: raw.id,
      sku: raw.sku,
      name: raw.name,
      slug: raw.slug,
      shortDescription: raw.short_description,
      description: raw.description,
      price: basePrice,
      compareAtPrice:
        raw.compare_at_price !== null ? Number(raw.compare_at_price) : null,
      effectivePrice: computeEffectivePrice(basePrice, activeDiscount),
      stock: Number(raw.stock),
      status: raw.status,
      category: raw.category,
      brand: raw.brand,
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      attributes:
        raw.attributes && typeof raw.attributes === 'object'
          ? raw.attributes
          : {},
      photoSettings:
        raw.photo_settings && typeof raw.photo_settings === 'object'
          ? raw.photo_settings
          : {},
      images: Array.isArray(raw.images) ? raw.images : [],
      options: Array.isArray(raw.options) ? raw.options : [],
      variants: Array.isArray(raw.variants)
        ? raw.variants.map((v) => ({
            ...v,
            price: Number(v.price),
            stock: Number(v.stock),
          }))
        : [],
      activeDiscount,
      createdAt: new Date(raw.created_at).toISOString(),
      updatedAt: new Date(raw.updated_at).toISOString(),
    };
  }

  async findById(id: string): Promise<ProductRow | null> {
    const pool = getPool();
    const { rows } = await pool.query<ProductRow>(
      `SELECT * FROM catalog.products WHERE id = $1 AND deleted_at IS NULL;`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findBySlug(slug: string): Promise<ProductRow | null> {
    const pool = getPool();
    const { rows } = await pool.query<ProductRow>(
      `SELECT * FROM catalog.products WHERE slug = $1 AND deleted_at IS NULL;`,
      [slug],
    );
    return rows[0] ?? null;
  }

  async findBySku(sku: string): Promise<ProductRow | null> {
    const pool = getPool();
    const { rows } = await pool.query<ProductRow>(
      `SELECT * FROM catalog.products WHERE sku = $1 AND deleted_at IS NULL;`,
      [sku],
    );
    return rows[0] ?? null;
  }

  async create(dto: CreateProductDto & { slug: string }): Promise<ProductDetail> {
    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO catalog.products (
         sku, name, slug, short_description, description, category_id, brand_id,
         price, compare_at_price, stock, status, tags, attributes, photo_settings,
         source, external_id, weight_g
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
       )
       RETURNING id;`,
      [
        dto.sku,
        dto.name,
        dto.slug,
        dto.shortDescription ?? null,
        dto.description ?? null,
        dto.categoryId ?? null,
        dto.brandId ?? null,
        dto.price,
        dto.compareAtPrice ?? null,
        dto.stock ?? 0,
        dto.status ?? 'draft',
        dto.tags ?? [],
        JSON.stringify(dto.attributes ?? {}),
        JSON.stringify(dto.photoSettings ?? {}),
        dto.source ?? 'local',
        dto.externalId ?? null,
        dto.weightG ?? null,
      ],
    );

    const created = await this.findDetail({ id: rows[0].id });
    return created!;
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductDetail | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (dto.sku !== undefined) {
      fields.push(`sku = $${idx++}`);
      values.push(dto.sku);
    }
    if (dto.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(dto.name);
    }
    if (dto.slug !== undefined) {
      fields.push(`slug = $${idx++}`);
      values.push(dto.slug);
    }
    if (dto.shortDescription !== undefined) {
      fields.push(`short_description = $${idx++}`);
      values.push(dto.shortDescription);
    }
    if (dto.description !== undefined) {
      fields.push(`description = $${idx++}`);
      values.push(dto.description);
    }
    if (dto.categoryId !== undefined) {
      fields.push(`category_id = $${idx++}`);
      values.push(dto.categoryId);
    }
    if (dto.brandId !== undefined) {
      fields.push(`brand_id = $${idx++}`);
      values.push(dto.brandId);
    }
    if (dto.price !== undefined) {
      fields.push(`price = $${idx++}`);
      values.push(dto.price);
    }
    if (dto.compareAtPrice !== undefined) {
      fields.push(`compare_at_price = $${idx++}`);
      values.push(dto.compareAtPrice);
    }
    if (dto.stock !== undefined) {
      fields.push(`stock = $${idx++}`);
      values.push(dto.stock);
    }
    if (dto.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(dto.status);
    }
    if (dto.tags !== undefined) {
      fields.push(`tags = $${idx++}`);
      values.push(dto.tags);
    }
    if (dto.attributes !== undefined) {
      fields.push(`attributes = $${idx++}`);
      values.push(JSON.stringify(dto.attributes));
    }
    if (dto.photoSettings !== undefined) {
      fields.push(`photo_settings = $${idx++}`);
      values.push(JSON.stringify(dto.photoSettings));
    }
    if (dto.weightG !== undefined) {
      fields.push(`weight_g = $${idx++}`);
      values.push(dto.weightG);
    }

    if (fields.length > 0) {
      values.push(id);
      const pool = getPool();
      await pool.query(
        `UPDATE catalog.products
         SET ${fields.join(', ')}
         WHERE id = $${idx} AND deleted_at IS NULL;`,
        values,
      );
    }

    return this.findDetail({ id });
  }

  async softDelete(id: string): Promise<boolean> {
    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE catalog.products
       SET deleted_at = now(), status = 'archived'
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id;`,
      [id],
    );
    return rows.length > 0;
  }

  // --- Variants ---
  async createVariant(
    productId: string,
    dto: CreateVariantDto,
  ): Promise<ProductVariant> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{
        id: string;
        product_id: string;
        sku: string;
        price: string;
        stock: number;
        image_url: string | null;
        is_active: boolean;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO catalog.product_variants (
           product_id, sku, price, stock, image_url, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, product_id, sku, price, stock, image_url, is_active, created_at, updated_at;`,
        [
          productId,
          dto.sku,
          dto.price,
          dto.stock ?? 0,
          dto.imageUrl ?? null,
          dto.isActive ?? true,
        ],
      );

      const variant = rows[0];

      if (dto.options && dto.options.length > 0) {
        for (const opt of dto.options) {
          await client.query(
            `INSERT INTO catalog.product_variant_option_values (variant_id, option_id, option_value_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (variant_id, option_id) DO UPDATE
             SET option_value_id = EXCLUDED.option_value_id;`,
            [variant.id, opt.optionId, opt.optionValueId],
          );
        }
      }

      await client.query('COMMIT');

      return {
        id: variant.id,
        productId: variant.product_id,
        sku: variant.sku,
        price: Number(variant.price),
        stock: Number(variant.stock),
        imageUrl: variant.image_url,
        isActive: variant.is_active,
        options: [],
        createdAt: new Date(variant.created_at).toISOString(),
        updatedAt: new Date(variant.updated_at).toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async updateVariant(
    id: string,
    dto: UpdateVariantDto,
  ): Promise<ProductVariant | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (dto.sku !== undefined) {
      fields.push(`sku = $${idx++}`);
      values.push(dto.sku);
    }
    if (dto.price !== undefined) {
      fields.push(`price = $${idx++}`);
      values.push(dto.price);
    }
    if (dto.stock !== undefined) {
      fields.push(`stock = $${idx++}`);
      values.push(dto.stock);
    }
    if (dto.imageUrl !== undefined) {
      fields.push(`image_url = $${idx++}`);
      values.push(dto.imageUrl);
    }
    if (dto.isActive !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(dto.isActive);
    }

    if (fields.length === 0) {
      return this.findVariantById(id);
    }

    values.push(id);
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      product_id: string;
      sku: string;
      price: string;
      stock: number;
      image_url: string | null;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE catalog.product_variants
       SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING id, product_id, sku, price, stock, image_url, is_active, created_at, updated_at;`,
      values,
    );

    if (rows.length === 0) return null;
    const v = rows[0];
    return {
      id: v.id,
      productId: v.product_id,
      sku: v.sku,
      price: Number(v.price),
      stock: Number(v.stock),
      imageUrl: v.image_url,
      isActive: v.is_active,
      options: [],
      createdAt: new Date(v.created_at).toISOString(),
      updatedAt: new Date(v.updated_at).toISOString(),
    };
  }

  async findVariantById(id: string): Promise<ProductVariant | null> {
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      product_id: string;
      sku: string;
      price: string;
      stock: number;
      image_url: string | null;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT * FROM catalog.product_variants WHERE id = $1;`,
      [id],
    );
    if (rows.length === 0) return null;
    const v = rows[0];
    return {
      id: v.id,
      productId: v.product_id,
      sku: v.sku,
      price: Number(v.price),
      stock: Number(v.stock),
      imageUrl: v.image_url,
      isActive: v.is_active,
      options: [],
      createdAt: new Date(v.created_at).toISOString(),
      updatedAt: new Date(v.updated_at).toISOString(),
    };
  }

  async deleteVariant(id: string): Promise<boolean> {
    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      `DELETE FROM catalog.product_variants WHERE id = $1 RETURNING id;`,
      [id],
    );
    return rows.length > 0;
  }

  // --- Options ---
  async createOption(
    productId: string,
    dto: CreateOptionDto,
  ): Promise<ProductOption> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const { rows: optRows } = await client.query<{
        id: string;
        product_id: string;
        name: string;
        position: number;
      }>(
        `INSERT INTO catalog.product_options (product_id, name, position)
         VALUES ($1, $2, $3)
         RETURNING id, product_id, name, position;`,
        [productId, dto.name, dto.position ?? 0],
      );

      const opt = optRows[0];
      const values: Array<{
        id: string;
        optionId: string;
        value: string;
        position: number;
      }> = [];

      for (let i = 0; i < dto.values.length; i++) {
        const valText = dto.values[i];
        const { rows: valRows } = await client.query<{
          id: string;
          option_id: string;
          value: string;
          position: number;
        }>(
          `INSERT INTO catalog.product_option_values (option_id, value, position)
           VALUES ($1, $2, $3)
           RETURNING id, option_id, value, position;`,
          [opt.id, valText, i],
        );
        values.push({
          id: valRows[0].id,
          optionId: valRows[0].option_id,
          value: valRows[0].value,
          position: valRows[0].position,
        });
      }

      await client.query('COMMIT');
      return {
        id: opt.id,
        productId: opt.product_id,
        name: opt.name,
        position: opt.position,
        values,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // --- Images ---
  async createImage(
    productId: string,
    dto: CreateImageDto,
  ): Promise<ProductImage> {
    const pool = getPool();

    if (dto.isPrimary) {
      await pool.query(
        `UPDATE catalog.product_images SET is_primary = false WHERE product_id = $1;`,
        [productId],
      );
    }

    const { rows } = await pool.query<{
      id: string;
      product_id: string;
      variant_id: string | null;
      url: string;
      alt: string | null;
      sort_order: number;
      is_primary: boolean;
      created_at: Date;
    }>(
      `INSERT INTO catalog.product_images (
         product_id, variant_id, url, alt, sort_order, is_primary
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, product_id, variant_id, url, alt, sort_order, is_primary, created_at;`,
      [
        productId,
        dto.variantId ?? null,
        dto.url,
        dto.alt ?? null,
        dto.sortOrder ?? 0,
        dto.isPrimary ?? false,
      ],
    );

    const img = rows[0];
    return {
      id: img.id,
      productId: img.product_id,
      variantId: img.variant_id,
      url: img.url,
      alt: img.alt,
      sortOrder: img.sort_order,
      isPrimary: img.is_primary,
      createdAt: new Date(img.created_at).toISOString(),
    };
  }

  async updateImage(id: string, dto: UpdateImageDto): Promise<ProductImage | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (dto.alt !== undefined) {
      fields.push(`alt = $${idx++}`);
      values.push(dto.alt);
    }
    if (dto.isPrimary !== undefined) {
      fields.push(`is_primary = $${idx++}`);
      values.push(dto.isPrimary);
    }
    if (dto.sortOrder !== undefined) {
      fields.push(`sort_order = $${idx++}`);
      values.push(dto.sortOrder);
    }

    if (fields.length === 0) return null;

    values.push(id);
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      product_id: string;
      variant_id: string | null;
      url: string;
      alt: string | null;
      sort_order: number;
      is_primary: boolean;
      created_at: Date;
    }>(
      `UPDATE catalog.product_images
       SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING id, product_id, variant_id, url, alt, sort_order, is_primary, created_at;`,
      values,
    );

    if (rows.length === 0) return null;
    const img = rows[0];
    return {
      id: img.id,
      productId: img.product_id,
      variantId: img.variant_id,
      url: img.url,
      alt: img.alt,
      sortOrder: img.sort_order,
      isPrimary: img.is_primary,
      createdAt: new Date(img.created_at).toISOString(),
    };
  }

  async deleteImage(id: string): Promise<boolean> {
    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      `DELETE FROM catalog.product_images WHERE id = $1 RETURNING id;`,
      [id],
    );
    return rows.length > 0;
  }

  // --- Discounts ---
  async createDiscount(
    productId: string,
    dto: CreateDiscountDto,
  ): Promise<ProductDiscount> {
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      product_id: string;
      discount_type: 'percent' | 'fixed';
      value: string;
      starts_at: Date;
      ends_at: Date;
      is_active: boolean;
    }>(
      `INSERT INTO catalog.product_discounts (
         product_id, discount_type, value, starts_at, ends_at, is_active
       ) VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, product_id, discount_type, value, starts_at, ends_at, is_active;`,
      [productId, dto.discountType, dto.value, dto.startsAt, dto.endsAt],
    );

    const d = rows[0];
    return {
      id: d.id,
      productId: d.product_id,
      discountType: d.discount_type,
      value: Number(d.value),
      startsAt: new Date(d.starts_at).toISOString(),
      endsAt: new Date(d.ends_at).toISOString(),
      isActive: d.is_active,
    };
  }

  async deleteDiscount(id: string): Promise<boolean> {
    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      `DELETE FROM catalog.product_discounts WHERE id = $1 RETURNING id;`,
      [id],
    );
    return rows.length > 0;
  }
}

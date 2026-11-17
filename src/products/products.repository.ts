import { Injectable } from '@nestjs/common';
import type { ProductBadgeItem } from '../badges/badges.types.js';
import { getPool } from '../db/pool.js';
import { withTransaction, type QueryHandle } from '../db/tx.js';
import {
  computeProductQueryFingerprint,
  decodeProductCursor,
  encodeProductCursor,
  resolveProductSort,
} from './cursor.codec.js';
import { CreateDiscountDto } from './dto/create-discount.dto.js';
import { CreateImageDto } from './dto/create-image.dto.js';
import { CreateOptionDto, UpdateOptionDto } from './dto/create-option.dto.js';
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
  ProductFacets,
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
  card_settings?: Record<string, unknown>;
  badges?: ProductBadgeItem[];
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
    displayType: 'text' | 'pill' | 'swatch';
    showOnCard: boolean;
    position: number;
    values: Array<{
      id: string;
      optionId: string;
      value: string;
      position: number;
      swatchHex?: string | null;
      swatchImageUrl?: string | null;
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
  popularity?: number;
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

    const effectiveSort = resolveProductSort(query);
    const fingerprint = computeProductQueryFingerprint(query);
    const cursor = query.cursor
      ? decodeProductCursor(query.cursor, fingerprint, effectiveSort)
      : null;

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

    // Manual curation (CMS featured_products source:"manual"): the id list
    // is a filter first and a default order second. The status floor above
    // stays, so a draft or archived id can never be pulled into a page.
    let idsParamIdx: number | null = null;
    if (query.ids && query.ids.length > 0) {
      idsParamIdx = idx++;
      conditions.push(`p.id = ANY($${idsParamIdx}::uuid[])`);
      values.push(query.ids);
    }

    if (query.minPrice !== undefined) {
      conditions.push(`p.price >= $${idx++}`);
      values.push(query.minPrice);
    }

    if (query.maxPrice !== undefined) {
      conditions.push(`p.price <= $${idx++}`);
      values.push(query.maxPrice);
    }

    if (query.tags && query.tags.length > 0) {
      conditions.push(`p.tags @> $${idx++}::varchar[]`);
      values.push(query.tags);
    }

    if (query.discounted === 'true') {
      // The active-discount lateral `d` is already joined above, so an
      // active discount row is the same condition effectivePrice uses.
      conditions.push(`d.discount_type IS NOT NULL`);
    }

    if (query.q && query.q.trim().length > 0) {
      conditions.push(`p.search_vector @@ plainto_tsquery('english', $${idx++})`);
      values.push(query.q.trim());
    }

    let orderBy: string;
    switch (effectiveSort) {
      case 'price_asc':
        orderBy = 'p.price ASC, p.id ASC';
        break;
      case 'price_desc':
        orderBy = 'p.price DESC, p.id DESC';
        break;
      case 'name_asc':
        orderBy = 'p.name ASC, p.id ASC';
        break;
      case 'rating_desc':
        orderBy = 'rv.avg_rating DESC NULLS LAST, p.id DESC';
        break;
      case 'popularity_desc':
        orderBy = 'p.popularity DESC, p.id DESC';
        break;
      case 'manual':
        // No explicit sort with an id list: the admin's order is the order.
        orderBy = `array_position($${idsParamIdx}::uuid[], p.id), p.id DESC`;
        break;
      default:
        orderBy = 'p.created_at DESC, p.id DESC';
    }

    // Keyset continuation: every predicate is on the *same* columns the
    // ORDER BY uses, so a page cannot repeat or skip a row. The id is always
    // the final tie-breaker; NULL ratings sort last on rating_desc.
    if (cursor !== null) {
      switch (effectiveSort) {
        case 'manual': {
          const pos = idx++;
          values.push(cursor.orderIndex ?? 0);
          conditions.push(`array_position($${idsParamIdx}::uuid[], p.id) > $${pos}`);
          break;
        }
        case 'created_desc': {
          const created = idx++;
          values.push(cursor.createdAt ?? '1970-01-01T00:00:00.000Z');
          const id = idx++;
          values.push(cursor.id);
          conditions.push(
            `(p.created_at, p.id) < ($${created}::timestamptz, $${id}::uuid)`,
          );
          break;
        }
        case 'price_asc':
        case 'price_desc': {
          const price = idx++;
          values.push(cursor.price ?? 0);
          const id = idx++;
          values.push(cursor.id);
          const cmp = effectiveSort === 'price_asc' ? '>' : '<';
          conditions.push(`(p.price, p.id) ${cmp} ($${price}::numeric, $${id}::uuid)`);
          break;
        }
        case 'name_asc': {
          const name = idx++;
          values.push(cursor.name ?? '');
          const id = idx++;
          values.push(cursor.id);
          conditions.push(`(p.name, p.id) > ($${name}::text, $${id}::uuid)`);
          break;
        }
        case 'rating_desc': {
          const id = idx++;
          values.push(cursor.id);
          if (cursor.rating === null || cursor.rating === undefined) {
            conditions.push(`rv.avg_rating IS NULL AND p.id < $${id}::uuid`);
          } else {
            const rating = idx++;
            values.push(cursor.rating);
            conditions.push(
              `(rv.avg_rating < $${rating}::numeric OR (` +
                `rv.avg_rating = $${rating}::numeric AND p.id < $${id}::uuid) ` +
                `OR rv.avg_rating IS NULL)`,
            );
          }
          break;
        }
        case 'popularity_desc': {
          const pop = idx++;
          values.push(cursor.popularity ?? 0);
          const id = idx++;
          values.push(cursor.id);
          conditions.push(`(p.popularity, p.id) < ($${pop}::integer, $${id}::uuid)`);
          break;
        }
      }
    }

    const sql = `
      SELECT p.id, p.sku, p.name, p.slug, p.short_description, p.price,
             p.compare_at_price, p.stock, p.status, p.tags, p.popularity, p.card_settings, p.created_at, p.updated_at,
             p.category_id, c.name AS category_name, c.slug AS category_slug,
             p.brand_id, b.name AS brand_name, b.slug AS brand_slug,
             pi.url AS primary_image_url,
             d.discount_type, d.value AS discount_value,
             rv.avg_rating AS avg_rating,
             coalesce(bdg.badges, '[]'::jsonb) AS badges,
             coalesce(opt.card_options, '[]'::jsonb) AS card_options,
             coalesce(imgs.images, '[]'::jsonb) AS images,
             coalesce(vars.variants, '[]'::jsonb) AS card_variants
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
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', b.id,
            'key', b.key,
            'label', b.label,
            'bg', b.bg,
            'textColor', b.text_color,
            'borderColor', b.border_color,
            'borderStyle', b.border_style,
            'sortOrder', pb.sort_order
          ) ORDER BY pb.sort_order ASC, pb.created_at ASC
        ) AS badges
        FROM catalog.product_badges pb
        JOIN catalog.badges b ON b.id = pb.badge_id
        WHERE pb.product_id = p.id
          AND b.is_active = true
          AND (pb.starts_at IS NULL OR pb.starts_at <= now())
          AND (pb.ends_at IS NULL OR pb.ends_at >= now())
      ) bdg ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', po.id,
            'name', po.name,
            'displayType', po.display_type,
            'showOnCard', po.show_on_card,
            'cardPlacement', coalesce(po.card_placement, CASE WHEN po.show_on_card THEN 'info' ELSE 'hidden' END),
            'values', coalesce(pov_agg.vals, '[]'::jsonb)
          ) ORDER BY po.position ASC, po.created_at ASC
        ) AS card_options
        FROM catalog.product_options po
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', pov.id,
              'value', pov.value,
              'position', pov.position,
              'swatchHex', pov.swatch_hex,
              'swatchImageUrl', pov.swatch_image_url
            ) ORDER BY pov.position ASC, pov.created_at ASC
          ) AS vals
          FROM catalog.product_option_values pov
          WHERE pov.option_id = po.id
        ) pov_agg ON true
        WHERE po.product_id = p.id
          AND (
            (po.card_placement IS NOT NULL AND po.card_placement <> 'hidden')
            OR (po.card_placement IS NULL AND po.show_on_card = true)
          )
      ) opt ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', pi_sub.id,
            'url', pi_sub.url,
            'alt', pi_sub.alt,
            'isPrimary', pi_sub.is_primary,
            'sortOrder', pi_sub.sort_order
          ) ORDER BY pi_sub.is_primary DESC, pi_sub.sort_order ASC, pi_sub.created_at ASC
        ) AS images
        FROM (
          SELECT id, url, alt, is_primary, sort_order, created_at
          FROM catalog.product_images
          WHERE product_id = p.id
          ORDER BY is_primary DESC, sort_order ASC, created_at ASC
          LIMIT 5
        ) pi_sub
      ) imgs ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', pv.id,
            'sku', pv.sku,
            'price', pv.price::numeric,
            'stock', pv.stock,
            'imageUrl', pv.image_url,
            'optionValues', coalesce(v_opts.opt_map, '{}'::jsonb)
          ) ORDER BY pv.created_at ASC
        ) AS variants
        FROM (
          SELECT pv_sub.id, pv_sub.sku, pv_sub.price, pv_sub.stock, pv_sub.image_url, pv_sub.created_at
          FROM catalog.product_variants pv_sub
          WHERE pv_sub.product_id = p.id AND pv_sub.is_active = true
          ORDER BY pv_sub.created_at ASC
          LIMIT 100
        ) pv
        LEFT JOIN LATERAL (
          SELECT jsonb_object_agg(po.name, pov.value) AS opt_map
          FROM catalog.product_variant_option_values pvov
          JOIN catalog.product_options po ON po.id = pvov.option_id
          JOIN catalog.product_option_values pov ON pov.id = pvov.option_value_id
          WHERE pvov.variant_id = pv.id
        ) v_opts ON true
      ) vars ON true
      LEFT JOIN LATERAL (
        SELECT avg(r.rating) AS avg_rating, count(r.id) AS rating_count
        FROM catalog.reviews r
        WHERE r.product_id = p.id AND r.is_approved = true
      ) rv ON true
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1};
    `;

    const { rows } = await pool.query<
      ProductRow & {
        discount_type?: 'percent' | 'fixed';
        discount_value?: string | number;
         avg_rating?: string | number | null;
         rating_count?: string | number;
         popularity?: number;
      }
    >(sql, values);

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeProductCursor({
            v: 1,
            q: fingerprint,
            sort: effectiveSort,
            id: last.id,
            ...(last.created_at !== undefined
              ? { createdAt: new Date(last.created_at).toISOString() }
              : {}),
            ...(last.price !== undefined ? { price: Number(last.price) } : {}),
            ...(last.name !== undefined ? { name: last.name } : {}),
            ...(last.avg_rating !== undefined
              ? {
                  rating:
                    last.avg_rating === null ? null : Number(last.avg_rating),
                }
              : {}),
            ...(last.popularity !== undefined
              ? { popularity: Number(last.popularity) }
              : {}),
            ...(effectiveSort === 'manual' && query.ids
              ? { orderIndex: query.ids.indexOf(last.id) }
              : {}),
          })
        : null;

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
        rating:
          row.avg_rating !== null && row.avg_rating !== undefined
            ? Number(row.avg_rating)
            : null,
        ratingCount:
          row.rating_count !== null && row.rating_count !== undefined
            ? Number(row.rating_count)
            : 0,
        popularity: Number(row.popularity ?? 0),
        cardSettings: row.card_settings ?? {},
        badges: row.badges ?? [],
        cardOptions: row.card_options ?? [],
        images: Array.isArray(row.images) && row.images.length > 0
          ? row.images
          : row.primary_image_url
            ? [{ id: 'pri', url: row.primary_image_url, alt: null, isPrimary: true, sortOrder: 0 }]
            : [],
        cardVariants: Array.isArray(row.card_variants) ? row.card_variants : [],
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });

    return { data, nextCursor };
  }

  /**
   * Distinct facet values over active products, optionally narrowed by
   * category/brand. Derived from rows, never seeded — a tag the rail offers
   * is a tag a real product carries.
   */
  async findFacets(filter: {
    categoryId?: string;
    brandId?: string;
  }): Promise<ProductFacets> {
    const pool = getPool();
    const { rows } = await pool.query<{
      tags: string[] | null;
      min_price: string | number | null;
      max_price: string | number | null;
    }>(
      `SELECT
         COALESCE(array_agg(DISTINCT t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}') AS tags,
         min(p.price) AS min_price,
         max(p.price) AS max_price
       FROM catalog.products p
       LEFT JOIN LATERAL unnest(p.tags) AS t(tag) ON true
       WHERE p.deleted_at IS NULL
         AND p.status = 'active'
         AND ($1::uuid IS NULL OR p.category_id = $1)
         AND ($2::uuid IS NULL OR p.brand_id = $2);`,
      [filter.categoryId ?? null, filter.brandId ?? null],
    );
    const row = rows[0];
    return {
      tags: Array.isArray(row?.tags) ? row.tags : [],
      minPrice: row?.min_price !== null && row?.min_price !== undefined
        ? Number(row.min_price)
        : null,
      maxPrice: row?.max_price !== null && row?.max_price !== undefined
        ? Number(row.max_price)
        : null,
    };
  }

  async findDetail(
    identifier: {
      slug?: string;
      id?: string;
    },
    client?: QueryHandle,
  ): Promise<ProductDetail | null> {
    const q = client ?? getPool();
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
        prod.price, prod.compare_at_price, prod.stock, prod.status, prod.tags, prod.popularity,
        prod.attributes, prod.photo_settings, prod.card_settings, prod.created_at, prod.updated_at,
        CASE WHEN prod.category_id IS NOT NULL THEN
          jsonb_build_object('id', prod.category_id, 'name', prod.cat_name, 'slug', prod.cat_slug)
        ELSE NULL END AS category,
        CASE WHEN prod.brand_id IS NOT NULL THEN
          jsonb_build_object('id', prod.brand_id, 'name', prod.br_name, 'slug', prod.br_slug, 'logoUrl', prod.br_logo)
        ELSE NULL END AS brand,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'id', b.id,
              'key', b.key,
              'label', b.label,
              'bg', b.bg,
              'textColor', b.text_color,
              'borderColor', b.border_color,
              'borderStyle', b.border_style,
              'sortOrder', pb.sort_order
            ) ORDER BY pb.sort_order ASC, pb.created_at ASC
          )
          FROM catalog.product_badges pb
          JOIN catalog.badges b ON b.id = pb.badge_id
          WHERE pb.product_id = prod.id
            AND b.is_active = true
            AND (pb.starts_at IS NULL OR pb.starts_at <= now())
            AND (pb.ends_at IS NULL OR pb.ends_at >= now())
        ), '[]'::json) AS badges,
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
              'displayType', po.display_type,
              'showOnCard', po.show_on_card,
              'position', po.position,
              'values', COALESCE((
                SELECT json_agg(
                  json_build_object(
                    'id', pov.id,
                    'optionId', pov.option_id,
                    'value', pov.value,
                    'position', pov.position,
                    'swatchHex', pov.swatch_hex,
                    'swatchImageUrl', pov.swatch_image_url
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

    const { rows } = await q.query<RawPdpRow>(sql, [
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
       popularity: Number(raw.popularity ?? 0),
      attributes:
        raw.attributes && typeof raw.attributes === 'object'
          ? raw.attributes
          : {},
      photoSettings:
        raw.photo_settings && typeof raw.photo_settings === 'object'
          ? raw.photo_settings
          : {},
      cardSettings:
        raw.card_settings && typeof raw.card_settings === 'object'
          ? raw.card_settings
          : {},
      badges: Array.isArray(raw.badges) ? raw.badges : [],
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

  async findById(id: string, client?: QueryHandle): Promise<ProductRow | null> {
    const q = client ?? getPool();
    const { rows } = await q.query<ProductRow>(
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

  async create(
    dto: CreateProductDto & { slug: string },
    client?: QueryHandle,
  ): Promise<ProductDetail> {
    const q = client ?? getPool();
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO catalog.products (
         sku, name, slug, short_description, description, category_id, brand_id,
         price, compare_at_price, stock, status, tags, attributes, photo_settings,
         card_settings, source, external_id, weight_g, popularity
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
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
        JSON.stringify(dto.cardSettings ?? {}),
        dto.source ?? 'local',
        dto.externalId ?? null,
        dto.weightG ?? null,
        dto.popularity ?? 0,
      ],
    );

    const created = await this.findDetail({ id: rows[0].id }, q);
    return created!;
  }

  async update(
    id: string,
    dto: UpdateProductDto,
    client?: QueryHandle,
  ): Promise<ProductDetail | null> {
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
    if (dto.cardSettings !== undefined) {
      fields.push(`card_settings = $${idx++}`);
      values.push(JSON.stringify(dto.cardSettings));
    }
    if (dto.weightG !== undefined) {
      fields.push(`weight_g = $${idx++}`);
      values.push(dto.weightG);
    }
    if (dto.popularity !== undefined) {
      fields.push(`popularity = $${idx++}`);
      values.push(dto.popularity);
    }

    if (fields.length > 0) {
      values.push(id);
      const q = client ?? getPool();
      await q.query(
        `UPDATE catalog.products
         SET ${fields.join(', ')}
         WHERE id = $${idx} AND deleted_at IS NULL;`,
        values,
      );
    }

    return this.findDetail({ id }, client);
  }

  /**
   * Soft-deletes the row and returns what committed, so the caller can record
   * `product.updated` from the same values a reader will see.
   */
  async softDelete(id: string, client?: QueryHandle): Promise<ProductRow | null> {
    const q = client ?? getPool();
    const { rows } = await q.query<ProductRow>(
      `UPDATE catalog.products
       SET deleted_at = now(), status = 'archived'
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *;`,
      [id],
    );
    return rows[0] ?? null;
  }

  // --- Variants ---
  async createVariant(
    productId: string,
    dto: CreateVariantDto,
    client?: QueryHandle,
  ): Promise<ProductVariant> {
    const insert = async (q: QueryHandle): Promise<ProductVariant> => {
      const { rows } = await q.query<{
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
          await q.query(
            `INSERT INTO catalog.product_variant_option_values (variant_id, option_id, option_value_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (variant_id, option_id) DO UPDATE
             SET option_value_id = EXCLUDED.option_value_id;`,
            [variant.id, opt.optionId, opt.optionValueId],
          );
        }
      }

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
    };

    // A caller that already owns a transaction passes its client; without one
    // the variant row and its option values still have to land together.
    return client ? insert(client) : withTransaction(insert);
  }

  async updateVariant(
    id: string,
    dto: UpdateVariantDto,
    client?: QueryHandle,
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
      return this.findVariantById(id, client);
    }

    values.push(id);
    const q = client ?? getPool();
    const { rows } = await q.query<{
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

  async setVariantOptions(
    variantId: string,
    options: { optionId: string; optionValueId: string }[],
    client?: QueryHandle,
  ): Promise<void> {
    const run = async (q: QueryHandle) => {
      await q.query(
        'DELETE FROM catalog.product_variant_option_values WHERE variant_id = $1',
        [variantId],
      );
      for (const opt of options) {
        await q.query(
          `INSERT INTO catalog.product_variant_option_values (variant_id, option_id, option_value_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (variant_id, option_id) DO UPDATE
           SET option_value_id = EXCLUDED.option_value_id;`,
          [variantId, opt.optionId, opt.optionValueId],
        );
      }
    };
    return client ? run(client) : withTransaction(run);
  }

  async findVariantById(
    id: string,
    client?: QueryHandle,
  ): Promise<ProductVariant | null> {
    const q = client ?? getPool();
    const { rows } = await q.query<{
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

  /**
   * Deletes the variant and returns the product it belonged to, so the caller
   * can re-read that product inside the same transaction and emit an event
   * describing what committed.
   */
  async deleteVariant(
    id: string,
    client?: QueryHandle,
  ): Promise<string | null> {
    const q = client ?? getPool();
    const { rows } = await q.query<{ product_id: string }>(
      `DELETE FROM catalog.product_variants WHERE id = $1 RETURNING product_id;`,
      [id],
    );
    return rows[0]?.product_id ?? null;
  }

  // --- Options ---
  async createOption(
    productId: string,
    dto: CreateOptionDto,
    client?: QueryHandle,
  ): Promise<ProductOption> {
    const insert = async (q: QueryHandle): Promise<ProductOption> => {
      const showOnCard =
        dto.cardPlacement !== undefined
          ? dto.cardPlacement !== 'hidden'
          : (dto.showOnCard ?? false);
      const cardPlacement = dto.cardPlacement ?? null;

      const { rows: optRows } = await q.query<{
        id: string;
        product_id: string;
        name: string;
        display_type: 'text' | 'pill' | 'swatch';
        show_on_card: boolean;
        card_placement?: 'info' | 'media' | 'brand-hover' | 'media-hover-top' | 'hidden' | null;
        position: number;
      }>(
        `INSERT INTO catalog.product_options (product_id, name, display_type, show_on_card, card_placement, position)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, product_id, name, display_type, show_on_card, card_placement, position;`,
        [
          productId,
          dto.name,
          dto.displayType ?? 'text',
          showOnCard,
          cardPlacement,
          dto.position ?? 0,
        ],
      );

      const opt = optRows[0];
      const values: Array<{
        id: string;
        optionId: string;
        value: string;
        position: number;
        swatchHex?: string | null;
        swatchImageUrl?: string | null;
      }> = [];

      for (let i = 0; i < dto.values.length; i++) {
        const item = dto.values[i];
        const valText = typeof item === 'string' ? item : item.value;
        const swatchHex = typeof item === 'string' ? null : (item.swatchHex ?? null);
        const swatchImageUrl =
          typeof item === 'string' ? null : (item.swatchImageUrl ?? null);

        const { rows: valRows } = await q.query<{
          id: string;
          option_id: string;
          value: string;
          position: number;
          swatch_hex: string | null;
          swatch_image_url: string | null;
        }>(
          `INSERT INTO catalog.product_option_values (option_id, value, position, swatch_hex, swatch_image_url)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, option_id, value, position, swatch_hex, swatch_image_url;`,
          [opt.id, valText, i, swatchHex, swatchImageUrl],
        );
        values.push({
          id: valRows[0].id,
          optionId: valRows[0].option_id,
          value: valRows[0].value,
          position: valRows[0].position,
          swatchHex: valRows[0].swatch_hex,
          swatchImageUrl: valRows[0].swatch_image_url,
        });
      }

      return {
        id: opt.id,
        productId: opt.product_id,
        name: opt.name,
        displayType: opt.display_type,
        showOnCard: opt.show_on_card,
        cardPlacement: opt.card_placement ?? undefined,
        position: opt.position,
        values,
      };
    };

    return client ? insert(client) : withTransaction(insert);
  }

  async updateOption(
    optionId: string,
    dto: UpdateOptionDto,
    client?: QueryHandle,
  ): Promise<ProductOption | null> {
    const q = client ?? getPool();
    const fields: string[] = [];
    const values: unknown[] = [optionId];
    let idx = 2;

    if (dto.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(dto.name);
    }
    if (dto.displayType !== undefined) {
      fields.push(`display_type = $${idx++}`);
      values.push(dto.displayType);
    }
    if (dto.showOnCard !== undefined) {
      fields.push(`show_on_card = $${idx++}`);
      values.push(dto.showOnCard);
    }
    if (dto.cardPlacement !== undefined) {
      fields.push(`card_placement = $${idx++}`);
      values.push(dto.cardPlacement);
      if (dto.showOnCard === undefined) {
        fields.push(`show_on_card = $${idx++}`);
        values.push(dto.cardPlacement !== 'hidden');
      }
    }
    if (dto.position !== undefined) {
      fields.push(`position = $${idx++}`);
      values.push(dto.position);
    }

    if (fields.length > 0) {
      await q.query(
        `UPDATE catalog.product_options SET ${fields.join(', ')} WHERE id = $1;`,
        values,
      );
    }

    const { rows: optRows } = await q.query<{
      id: string;
      product_id: string;
      name: string;
      display_type: 'text' | 'pill' | 'swatch';
      show_on_card: boolean;
      card_placement?: 'info' | 'media' | 'brand-hover' | 'media-hover-top' | 'hidden' | null;
      position: number;
    }>(
      `SELECT id, product_id, name, display_type, show_on_card, card_placement, position
       FROM catalog.product_options WHERE id = $1;`,
      [optionId],
    );
    if (optRows.length === 0) return null;

    const opt = optRows[0];
    const { rows: valRows } = await q.query<{
      id: string;
      option_id: string;
      value: string;
      position: number;
      swatch_hex: string | null;
      swatch_image_url: string | null;
    }>(
      `SELECT id, option_id, value, position, swatch_hex, swatch_image_url
       FROM catalog.product_option_values
       WHERE option_id = $1
       ORDER BY position ASC;`,
      [optionId],
    );

    return {
      id: opt.id,
      productId: opt.product_id,
      name: opt.name,
      displayType: opt.display_type,
      showOnCard: opt.show_on_card,
      cardPlacement: opt.card_placement ?? undefined,
      position: opt.position,
      values: valRows.map((v) => ({
        id: v.id,
        optionId: v.option_id,
        value: v.value,
        position: v.position,
        swatchHex: v.swatch_hex,
        swatchImageUrl: v.swatch_image_url,
      })),
    };
  }

  // --- Images ---
  async createImage(
    productId: string,
    dto: CreateImageDto,
    client?: QueryHandle,
  ): Promise<ProductImage> {
    const q = client ?? getPool();

    if (dto.isPrimary) {
      await q.query(
        `UPDATE catalog.product_images SET is_primary = false WHERE product_id = $1;`,
        [productId],
      );
    }

    const { rows } = await q.query<{
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

  async updateImage(
    id: string,
    dto: UpdateImageDto,
    client?: QueryHandle,
  ): Promise<ProductImage | null> {
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
    const q = client ?? getPool();
    const { rows } = await q.query<{
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

  async deleteImage(id: string, client?: QueryHandle): Promise<string | null> {
    const q = client ?? getPool();
    const { rows } = await q.query<{ id: string; product_id: string }>(
      `DELETE FROM catalog.product_images WHERE id = $1 RETURNING id, product_id;`,
      [id],
    );
    return rows.length > 0 ? rows[0].product_id : null;
  }

  // --- Discounts ---
  async createDiscount(
    productId: string,
    dto: CreateDiscountDto,
    client?: QueryHandle,
  ): Promise<ProductDiscount> {
    const q = client ?? getPool();
    const { rows } = await q.query<{
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

  /**
   * Deletes the discount and returns the product it was attached to, so the
   * caller can re-read that product inside the same transaction.
   */
  async deleteDiscount(
    id: string,
    client?: QueryHandle,
  ): Promise<string | null> {
    const q = client ?? getPool();
    const { rows } = await q.query<{ product_id: string }>(
      `DELETE FROM catalog.product_discounts WHERE id = $1 RETURNING product_id;`,
      [id],
    );
    return rows[0]?.product_id ?? null;
  }
}

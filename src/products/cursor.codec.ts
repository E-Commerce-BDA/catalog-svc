import { createHash } from 'node:crypto';

/**
 * Keyset cursor for the public product list (cat-015).
 *
 * The previous cursor was a bare product id and the walk used `p.id > $cursor`
 * against `ORDER BY created_at DESC, id DESC` — that is not a keyset predicate,
 * so page 2 repeated rows from page 1. A cursor now carries the sort key of the
 * last row plus a fingerprint of the filters that produced it, so a stale or
 * hand-edited cursor cannot silently change the result set.
 *
 * Mirrors search-svc's `cursor.codec.ts` (opaque base64url, fingerprint, strict
 * version check) without importing anything from that service.
 */
export type ProductSort =
  | 'created_desc'
  | 'price_asc'
  | 'price_desc'
  | 'name_asc'
  | 'rating_desc'
  | 'popularity_desc'
  | 'manual';

/** Only the fields that change *which* rows are in the walk. `limit` does not. */
export interface ProductCursorQuery {
  includeInactive?: string;
  status?: string;
  categoryId?: string;
  brandId?: string;
  ids?: string[];
  minPrice?: number;
  maxPrice?: number;
  tags?: string[];
  discounted?: string;
  q?: string;
  sort?: string;
}

export interface ProductCursorPayload {
  v: 1;
  /** sha256 of the canonical query — rejects a cursor from another filter set. */
  q: string;
  sort: ProductSort;
  /** UUID tie-breaker, always present. */
  id: string;
  createdAt?: string;
  price?: number;
  name?: string;
  rating?: number | null;
  popularity?: number;
  /** `array_position` in the manual `ids` list, for curated sections. */
  orderIndex?: number;
}

export class CursorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorValidationError';
  }
}

/** Manual curation (ids) has no default `created_desc` walk. */
export function resolveProductSort(query: ProductCursorQuery): ProductSort {
  if (query.sort) return query.sort as ProductSort;
  return query.ids && query.ids.length > 0 ? 'manual' : 'created_desc';
}

/** Deterministic fingerprint of every membership-affecting filter + the sort. */
export function computeProductQueryFingerprint(query: ProductCursorQuery): string {
  const sort = resolveProductSort(query);
  const parts = [
    query.includeInactive ?? '',
    query.status ?? '',
    query.categoryId ?? '',
    query.brandId ?? '',
    (query.ids ?? []).join(','),
    query.minPrice !== undefined ? String(query.minPrice) : '',
    query.maxPrice !== undefined ? String(query.maxPrice) : '',
    (query.tags ?? []).join(','),
    query.discounted ?? '',
    (query.q ?? '').trim().toLowerCase(),
    sort,
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export function encodeProductCursor(payload: ProductCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeProductCursor(
  raw: string,
  expectedFingerprint: string,
  expectedSort: ProductSort,
): ProductCursorPayload {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new CursorValidationError('Cursor must be a non-empty string');
  }

  let parsed: unknown;
  try {
    const buf = Buffer.from(raw, 'base64url');
    if (buf.length === 0 || buf.toString('base64url') !== raw) {
      throw new Error('not canonical base64url');
    }
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new CursorValidationError('Cursor is not valid base64url JSON');
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new CursorValidationError('Cursor payload must be an object');
  }
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) throw new CursorValidationError('Unsupported cursor version');
  if (p.q !== expectedFingerprint) {
    throw new CursorValidationError('Cursor does not match the requested filters');
  }
  if (p.sort !== expectedSort) {
    throw new CursorValidationError('Cursor does not match the requested sort');
  }
  if (typeof p.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.id)) {
    throw new CursorValidationError('Cursor is missing a valid id');
  }

  return {
    v: 1,
    q: p.q,
    sort: p.sort as ProductSort,
    id: p.id,
    ...(typeof p.createdAt === 'string' ? { createdAt: p.createdAt } : {}),
    ...(typeof p.price === 'number' ? { price: p.price } : {}),
    ...(typeof p.name === 'string' ? { name: p.name } : {}),
    ...(p.rating === null || typeof p.rating === 'number' ? { rating: p.rating } : {}),
    ...(typeof p.popularity === 'number' ? { popularity: p.popularity } : {}),
    ...(typeof p.orderIndex === 'number' ? { orderIndex: p.orderIndex } : {}),
  };
}

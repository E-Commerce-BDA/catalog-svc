import { describe, expect, it } from 'vitest';
import {
  computeProductQueryFingerprint,
  CursorValidationError,
  decodeProductCursor,
  encodeProductCursor,
  resolveProductSort,
} from './cursor.codec.js';

const base = {
  categoryId: '0190a8b0-0000-7000-8000-000000000003',
  sort: 'created_desc',
  tags: ['linen', 'summer'],
  discounted: 'true',
};

describe('product cursor codec', () => {
  it('resolves the manual sort only for curated id lists', () => {
    expect(resolveProductSort({})).toBe('created_desc');
    expect(resolveProductSort({ ids: ['a'] })).toBe('manual');
    expect(resolveProductSort({ sort: 'price_asc' })).toBe('price_asc');
  });

  it('fingerprints every membership-affecting filter and the sort', () => {
    const a = computeProductQueryFingerprint(base);
    expect(a).toBe(computeProductQueryFingerprint(base));
    expect(a).not.toBe(
      computeProductQueryFingerprint({ ...base, tags: ['linen'] }),
    );
    expect(a).not.toBe(
      computeProductQueryFingerprint({ ...base, sort: 'price_asc' }),
    );
    // limit is a page size, not a member of the result set.
    const withLimit = { ...base, limit: 12 };
    expect(a).toBe(computeProductQueryFingerprint(withLimit));
  });

  it('round-trips a keyset payload with the sort key', () => {
    const fingerprint = computeProductQueryFingerprint(base);
    const encoded = encodeProductCursor({
      v: 1,
      q: fingerprint,
      sort: 'created_desc',
      id: '0190a8b0-0000-7000-8000-000000000101',
      createdAt: '2026-01-02T03:04:05.000Z',
      price: 42.5,
      popularity: 7,
      rating: 4.5,
    });
    expect(decodeProductCursor(encoded, fingerprint, 'created_desc')).toEqual({
      v: 1,
      q: fingerprint,
      sort: 'created_desc',
      id: '0190a8b0-0000-7000-8000-000000000101',
      createdAt: '2026-01-02T03:04:05.000Z',
      price: 42.5,
      popularity: 7,
      rating: 4.5,
    });
  });

  it('rejects a cursor from another filter set or sort', () => {
    const fingerprint = computeProductQueryFingerprint(base);
    const encoded = encodeProductCursor({
      v: 1,
      q: fingerprint,
      sort: 'created_desc',
      id: '0190a8b0-0000-7000-8000-000000000101',
    });
    expect(() => decodeProductCursor(encoded, 'other', 'created_desc')).toThrow(
      CursorValidationError,
    );
    expect(() => decodeProductCursor(encoded, fingerprint, 'price_asc')).toThrow(
      CursorValidationError,
    );
  });

  it('rejects malformed cursors', () => {
    const fingerprint = computeProductQueryFingerprint(base);
    expect(() => decodeProductCursor('', fingerprint, 'created_desc')).toThrow(
      CursorValidationError,
    );
    expect(() => decodeProductCursor('not base64', fingerprint, 'created_desc')).toThrow(
      CursorValidationError,
    );
    const wrongVersion = Buffer.from(
      JSON.stringify({
        v: 2,
        q: fingerprint,
        sort: 'created_desc',
        id: '0190a8b0-0000-7000-8000-000000000101',
      }),
    ).toString('base64url');
    expect(() =>
      decodeProductCursor(wrongVersion, fingerprint, 'created_desc'),
    ).toThrow(CursorValidationError);
  });
});

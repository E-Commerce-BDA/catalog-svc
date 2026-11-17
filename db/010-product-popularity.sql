-- cat-014: popularity ranking field for the catalog listing sort.
--
-- catalog-svc has no order or click data, so popularity is a stored admin-set
-- ranking boost, mirroring search-svc's read-model counter. It defaults to 0
-- and is never derived or fabricated by the seed.
ALTER TABLE catalog.products
  ADD COLUMN IF NOT EXISTS popularity integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_products_active_popularity
  ON catalog.products (status, popularity)
  WHERE status = 'active';

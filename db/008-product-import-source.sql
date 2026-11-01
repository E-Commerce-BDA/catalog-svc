BEGIN;

-- 008-product-import-source.sql — cat-008: allow source = 'import'.
-- Apply after 007-catalog-outbox.sql.
--
-- 001 enumerated the *platform syncs* catalog could take a product from:
-- local, shopify, bigcommerce, odoo. cat-008 adds a second writer with a
-- different provenance: a `product.imported` payload carries no `source` field
-- (the contract never had one), so the consumer stamps every row it creates.
--
-- Writing 'local' for those rows was the alternative, and it is a lie: it makes
-- an imported feed row indistinguishable from one an admin typed in, and there
-- is then no way to answer "what did the last import touch?". So the enum grows
-- by one value instead.
--
-- The task log for cat-008 says "no migration is needed". That conclusion was
-- drawn from the tables the import writes (`processed_events` from 006,
-- `stock_movements.reason = 'import'` already legal in 001) and missed this
-- CHECK, which is the one thing that did need a migration. It is the only
-- schema change in the task.
--
-- `create-product.dto.ts` deliberately keeps its own @IsIn list without
-- 'import': an admin creating a product over HTTP cannot claim the importer's
-- provenance, only the importer can.

ALTER TABLE catalog.products
  DROP CONSTRAINT IF EXISTS products_source_check;

ALTER TABLE catalog.products
  ADD CONSTRAINT products_source_check
  CHECK (source IN ('local', 'shopify', 'bigcommerce', 'odoo', 'import'));

COMMIT;

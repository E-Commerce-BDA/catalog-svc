CREATE SCHEMA IF NOT EXISTS catalog;

-- 12. stock_reservations (idempotent holds placed by order-svc)
--
-- Idempotency lives in the primary key: the reservation id is supplied by the
-- caller, so `INSERT ... ON CONFLICT (id) DO NOTHING` doubles as the concurrency
-- gate. A replay blocks on the index entry until the first transaction commits,
-- then reads the stored result and returns it unchanged.
--
-- `items` stores the *result* shape (productId, variantId, quantity,
-- remainingStock) so a replay answers with the exact original body.
CREATE TABLE IF NOT EXISTS catalog.stock_reservations (
  id uuid NOT NULL,
  order_id uuid NULL,
  status varchar(16) NOT NULL DEFAULT 'held',
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_reservations_pkey PRIMARY KEY (id),
  CONSTRAINT stock_reservations_status_check
    CHECK (status IN ('held', 'committed', 'released', 'expired')),
  CONSTRAINT stock_reservations_items_check
    CHECK (jsonb_typeof(items) = 'array')
);

-- One reservation per order. Partial, because the order does not exist yet when
-- checkout reserves stock; it is attached on commit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_reservations_order
  ON catalog.stock_reservations (order_id)
  WHERE order_id IS NOT NULL;

-- Drives the expiry sweep: `WHERE status = 'held' AND expires_at <= now()`.
CREATE INDEX IF NOT EXISTS idx_stock_reservations_due
  ON catalog.stock_reservations (expires_at)
  WHERE status = 'held';

-- Audit ledger link: which hold produced this movement.
ALTER TABLE catalog.stock_movements
  ADD COLUMN IF NOT EXISTS reservation_id uuid NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_reservation
  ON catalog.stock_movements (reservation_id)
  WHERE reservation_id IS NOT NULL;

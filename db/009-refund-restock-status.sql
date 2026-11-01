-- cat-012: restock after a post-commit refund.
--
-- A reservation moves `committed` → `refunded` when its order is refunded after
-- the stock was sold. `released` cannot be reused for that transition: it means
-- "the hold was cancelled before the sale", and the audit must be able to tell a
-- genuine restock-after-sale apart from a cancellation. The movement ledger
-- already records why the units came back (reason `return`, legal since 001);
-- this widens the reservation state so the hold's own row agrees with the ledger.
--
-- `refunded` is terminal, like `released` and `expired`: the units are back on
-- the shelf and the hold has served its whole life. It is never re-entered, so a
-- replayed `order.status.updated` for the same order is a no-op.
ALTER TABLE catalog.stock_reservations
  DROP CONSTRAINT stock_reservations_status_check,
  ADD CONSTRAINT stock_reservations_status_check
    CHECK (status IN ('held', 'committed', 'released', 'expired', 'refunded'));

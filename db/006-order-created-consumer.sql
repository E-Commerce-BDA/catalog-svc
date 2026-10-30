BEGIN;

CREATE SCHEMA IF NOT EXISTS catalog;

-- 13. processed_events (consumer-side idempotency for catalog-svc)
--
-- One row per Kafka event id whose side effect has been applied. The row is
-- claimed and the side effect applied in the *same* transaction, so:
--
--   * a committed row means "this event was processed, skip it";
--   * a rolled-back transaction leaves no row, so a redelivery retries the work.
--
-- The invariant matters for terminal-but-unapplied outcomes: a reservation that
-- is already released/expired, or belongs to another order, cannot be repaired
-- by consuming the event again. Those paths throw and roll the claim back
-- instead of recording a success, which keeps `<topic>.dlq` the only record of
-- a failed event.
--
-- Retention is not implemented yet. The index on processed_at exists so a
-- future sweeper can prune rows older than the longest possible redelivery
-- window (Kafka `retention.ms`, 7 days by default) without a full scan.
CREATE TABLE IF NOT EXISTS catalog.processed_events (
  event_id     varchar(64)  NOT NULL,
  topic        varchar(64)  NOT NULL,
  processed_at timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT processed_events_pkey PRIMARY KEY (event_id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_processed_events_processed_at
  ON catalog.processed_events (processed_at);

COMMIT;

-- Migration 005: Add card_placement to catalog.product_options
ALTER TABLE catalog.product_options
  ADD COLUMN IF NOT EXISTS card_placement varchar(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_options_card_placement_check'
      AND conrelid = 'catalog.product_options'::regclass
  ) THEN
    ALTER TABLE catalog.product_options
      ADD CONSTRAINT product_options_card_placement_check
      CHECK (
        card_placement IS NULL
        OR card_placement IN ('info', 'media', 'brand-hover', 'media-hover-top', 'hidden')
      );
  END IF;
END $$;

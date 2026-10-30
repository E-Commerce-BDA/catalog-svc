-- Migration: 004-badges-and-card-settings.sql
-- Description: Centralized badges registry, product badge assignments, card_settings, and product option swatches/pills

-- 1. catalog.badges
CREATE TABLE IF NOT EXISTS catalog.badges (
  id uuid DEFAULT gen_random_uuid(),
  key varchar(64) NOT NULL,
  label varchar(64) NOT NULL,
  bg varchar(9) NOT NULL,
  text_color varchar(9) NOT NULL,
  border_color varchar(9),
  border_style varchar(10) DEFAULT 'solid',
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT badges_pkey PRIMARY KEY (id),
  CONSTRAINT badges_key_unique UNIQUE (key),
  CONSTRAINT badges_border_style_check CHECK (border_style IN ('solid', 'dashed', 'dotted'))
);

CREATE INDEX IF NOT EXISTS idx_badges_active
  ON catalog.badges (is_active)
  WHERE is_active = true;

-- 2. catalog.product_badges (product-badge assignment junction)
CREATE TABLE IF NOT EXISTS catalog.product_badges (
  product_id uuid NOT NULL,
  badge_id uuid NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT product_badges_pkey PRIMARY KEY (product_id, badge_id),
  CONSTRAINT product_badges_product_id_fkey FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE CASCADE,
  CONSTRAINT product_badges_badge_id_fkey FOREIGN KEY (badge_id) REFERENCES catalog.badges(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_badges_lookup
  ON catalog.product_badges (product_id, sort_order);

-- 3. catalog.products card_settings column
ALTER TABLE catalog.products
  ADD COLUMN IF NOT EXISTS card_settings jsonb DEFAULT '{}'::jsonb NOT NULL;

-- 4. catalog.product_options columns (for swatches and pills display on card)
ALTER TABLE catalog.product_options
  ADD COLUMN IF NOT EXISTS display_type varchar(20) DEFAULT 'text' NOT NULL,
  ADD COLUMN IF NOT EXISTS show_on_card boolean DEFAULT false NOT NULL;

-- 5. catalog.product_option_values columns (hex color or texture image)
ALTER TABLE catalog.product_option_values
  ADD COLUMN IF NOT EXISTS swatch_hex varchar(9),
  ADD COLUMN IF NOT EXISTS swatch_image_url varchar(2048);

-- 6. Seed initial platform badges (if not exists)
INSERT INTO catalog.badges (id, key, label, bg, text_color, border_color, border_style, is_active)
VALUES
  ('b0000000-0000-0000-0000-000000000001', 'sale', 'Sale', '#e11d48', '#ffffff', NULL, 'solid', true),
  ('b0000000-0000-0000-0000-000000000002', 'new', 'New Arrival', '#0284c7', '#ffffff', NULL, 'solid', true),
  ('b0000000-0000-0000-0000-000000000003', 'staff-pick', 'Staff Pick', '#059669', '#ffffff', NULL, 'solid', true),
  ('b0000000-0000-0000-0000-000000000004', 'sustainable', 'Eco-Friendly', '#166534', '#dcfce7', '#22c55e', 'solid', true),
  ('b0000000-0000-0000-0000-000000000005', 'limited', 'Limited Edition', '#7c3aed', '#f5f3ff', '#a855f7', 'dashed', true)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  bg = EXCLUDED.bg,
  text_color = EXCLUDED.text_color,
  border_color = EXCLUDED.border_color,
  border_style = EXCLUDED.border_style,
  is_active = EXCLUDED.is_active;

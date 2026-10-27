BEGIN;

CREATE SCHEMA IF NOT EXISTS catalog;

-- 1. categories (self-referencing tree, navbar/megamenu toggles, search vector)
CREATE TABLE IF NOT EXISTS catalog.categories (
  id uuid DEFAULT gen_random_uuid(),
  parent_id uuid,
  name varchar(150) NOT NULL,
  slug varchar(180) NOT NULL,
  description text,
  image_url varchar(2048),
  is_active boolean DEFAULT true NOT NULL,
  show_in_navbar boolean DEFAULT false NOT NULL,
  show_in_megamenu boolean DEFAULT false NOT NULL,
  megamenu_show_images boolean DEFAULT false NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  settings jsonb DEFAULT '{}'::jsonb NOT NULL,
  deleted_at timestamptz,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', name || ' ' || coalesce(description, ''))) STORED,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT categories_pkey PRIMARY KEY (id),
  CONSTRAINT categories_slug_key UNIQUE (slug),
  CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES catalog.categories(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_parent_id
  ON catalog.categories (parent_id);

CREATE INDEX IF NOT EXISTS idx_categories_search_vector
  ON catalog.categories USING gin (search_vector);

CREATE INDEX IF NOT EXISTS idx_categories_navbar
  ON catalog.categories (is_active, show_in_navbar, sort_order)
  WHERE is_active AND show_in_navbar;

-- 2. brands
CREATE TABLE IF NOT EXISTS catalog.brands (
  id uuid DEFAULT gen_random_uuid(),
  name varchar(150) NOT NULL,
  slug varchar(180) NOT NULL,
  logo_url varchar(2048),
  description text,
  is_active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT brands_pkey PRIMARY KEY (id),
  CONSTRAINT brands_slug_key UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS idx_brands_active
  ON catalog.brands (is_active)
  WHERE is_active;

-- 3. products
CREATE TABLE IF NOT EXISTS catalog.products (
  id uuid DEFAULT gen_random_uuid(),
  sku varchar(64) NOT NULL,
  name varchar(255) NOT NULL,
  slug varchar(280) NOT NULL,
  short_description varchar(500),
  description text,
  category_id uuid,
  brand_id uuid,
  price DECIMAL(12, 2) NOT NULL,
  compare_at_price DECIMAL(12, 2),
  stock integer DEFAULT 0 NOT NULL,
  status varchar(20) DEFAULT 'draft' NOT NULL,
  tags varchar(50)[],
  attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
  photo_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
  source varchar(20) DEFAULT 'local' NOT NULL,
  external_id varchar(255),
  weight_g integer,
  deleted_at timestamptz,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', name || ' ' || coalesce(short_description, '') || ' ' || coalesce(description, ''))
  ) STORED,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT products_pkey PRIMARY KEY (id),
  CONSTRAINT products_sku_key UNIQUE (sku),
  CONSTRAINT products_slug_key UNIQUE (slug),
  CONSTRAINT products_price_check CHECK (price >= 0),
  CONSTRAINT products_compare_at_price_check CHECK (compare_at_price IS NULL OR compare_at_price >= 0),
  CONSTRAINT products_stock_check CHECK (stock >= 0),
  CONSTRAINT products_status_check CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT products_source_check CHECK (source IN ('local', 'shopify', 'bigcommerce', 'odoo')),
  CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES catalog.categories(id) ON DELETE SET NULL,
  CONSTRAINT products_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES catalog.brands(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_products_category_id
  ON catalog.products (category_id);

CREATE INDEX IF NOT EXISTS idx_products_brand_id
  ON catalog.products (brand_id);

CREATE INDEX IF NOT EXISTS idx_products_search_vector
  ON catalog.products USING gin (search_vector);

CREATE INDEX IF NOT EXISTS idx_products_active
  ON catalog.products (status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_products_tags
  ON catalog.products USING gin (tags);

CREATE UNIQUE INDEX IF NOT EXISTS products_source_external_key
  ON catalog.products (source, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_active_price
  ON catalog.products (status, price)
  WHERE status = 'active';

-- 4. product_variants
CREATE TABLE IF NOT EXISTS catalog.product_variants (
  id uuid DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  sku varchar(64) NOT NULL,
  price DECIMAL(12, 2) NOT NULL,
  stock integer DEFAULT 0 NOT NULL,
  image_url varchar(2048),
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT product_variants_pkey PRIMARY KEY (id),
  CONSTRAINT product_variants_sku_key UNIQUE (sku),
  CONSTRAINT product_variants_price_check CHECK (price >= 0),
  CONSTRAINT product_variants_stock_check CHECK (stock >= 0),
  CONSTRAINT product_variants_product_id_fkey FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product_id
  ON catalog.product_variants (product_id);

CREATE INDEX IF NOT EXISTS idx_product_variants_active
  ON catalog.product_variants (product_id, is_active)
  WHERE is_active;

-- 5. product_images
CREATE TABLE IF NOT EXISTS catalog.product_images (
  id uuid DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  variant_id uuid,
  url varchar(2048) NOT NULL,
  alt varchar(255),
  sort_order integer DEFAULT 0 NOT NULL,
  is_primary boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT product_images_pkey PRIMARY KEY (id),
  CONSTRAINT product_images_product_id_fkey FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE CASCADE,
  CONSTRAINT product_images_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES catalog.product_variants(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_product_images_product_order
  ON catalog.product_images (product_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_product_images_variant_id
  ON catalog.product_images (variant_id);

CREATE UNIQUE INDEX IF NOT EXISTS one_primary_per_product
  ON catalog.product_images (product_id)
  WHERE is_primary;

-- 6. product_options (definitions stored once)
CREATE TABLE IF NOT EXISTS catalog.product_options (
  id uuid DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  name varchar(100) NOT NULL,
  position integer DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT product_options_pkey PRIMARY KEY (id),
  CONSTRAINT product_options_product_id_fkey FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_options_product_id
  ON catalog.product_options (product_id);

-- 7. product_option_values (values stored once)
CREATE TABLE IF NOT EXISTS catalog.product_option_values (
  id uuid DEFAULT gen_random_uuid(),
  option_id uuid NOT NULL,
  value varchar(150) NOT NULL,
  position integer DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT product_option_values_pkey PRIMARY KEY (id),
  CONSTRAINT values_per_option_unique UNIQUE (option_id, value),
  CONSTRAINT product_option_values_option_id_fkey FOREIGN KEY (option_id) REFERENCES catalog.product_options(id) ON DELETE CASCADE
);

-- 8. product_variant_option_values (junction table)
CREATE TABLE IF NOT EXISTS catalog.product_variant_option_values (
  variant_id uuid NOT NULL,
  option_id uuid NOT NULL,
  option_value_id uuid NOT NULL,
  CONSTRAINT product_variant_option_values_pkey PRIMARY KEY (variant_id, option_id),
  CONSTRAINT pvov_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  CONSTRAINT pvov_option_id_fkey FOREIGN KEY (option_id) REFERENCES catalog.product_options(id) ON DELETE CASCADE,
  CONSTRAINT pvov_option_value_id_fkey FOREIGN KEY (option_value_id) REFERENCES catalog.product_option_values(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pvov_option_value_id
  ON catalog.product_variant_option_values (option_value_id);

CREATE INDEX IF NOT EXISTS idx_pvov_option_id
  ON catalog.product_variant_option_values (option_id);

-- 9. product_attributes & product_attribute_values (compare engine)
CREATE TABLE IF NOT EXISTS catalog.product_attributes (
  id uuid DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  slug varchar(120) NOT NULL,
  type varchar(20) NOT NULL,
  unit varchar(20),
  CONSTRAINT product_attributes_pkey PRIMARY KEY (id),
  CONSTRAINT product_attributes_slug_key UNIQUE (slug),
  CONSTRAINT product_attributes_type_check CHECK (type IN ('text', 'number', 'boolean'))
);

CREATE TABLE IF NOT EXISTS catalog.product_attribute_values (
  id uuid DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  attribute_id uuid NOT NULL,
  value varchar(255) NOT NULL,
  CONSTRAINT product_attribute_values_pkey PRIMARY KEY (id),
  CONSTRAINT pav_product_attr_unique UNIQUE (product_id, attribute_id),
  CONSTRAINT pav_product_id_fkey FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE CASCADE,
  CONSTRAINT pav_attribute_id_fkey FOREIGN KEY (attribute_id) REFERENCES catalog.product_attributes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pav_attribute_id
  ON catalog.product_attribute_values (attribute_id);

-- 10. stock_movements (audit ledger)
CREATE TABLE IF NOT EXISTS catalog.stock_movements (
  id uuid DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  variant_id uuid,
  qty_change integer NOT NULL,
  reason varchar(30) NOT NULL,
  order_id uuid,
  qty_after integer NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT stock_movements_pkey PRIMARY KEY (id),
  CONSTRAINT stock_movements_reason_check CHECK (reason IN ('sale', 'restock', 'import', 'admin_adjustment', 'return', 'cancel')),
  CONSTRAINT stock_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE CASCADE,
  CONSTRAINT stock_movements_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES catalog.product_variants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_time
  ON catalog.stock_movements (product_id, created_at);

CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at
  ON catalog.stock_movements (created_at);

-- 11. product_discounts (scheduled discounts)
CREATE TABLE IF NOT EXISTS catalog.product_discounts (
  id uuid DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  discount_type varchar(10) NOT NULL,
  value DECIMAL(12, 2) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT product_discounts_pkey PRIMARY KEY (id),
  CONSTRAINT product_discounts_type_check CHECK (discount_type IN ('percent', 'fixed')),
  CONSTRAINT product_discounts_value_check CHECK (value >= 0 AND ((discount_type = 'percent' AND value <= 100) OR discount_type = 'fixed')),
  CONSTRAINT product_discounts_product_id_fkey FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_discounts_active
  ON catalog.product_discounts (product_id, is_active)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_discounts_active_range
  ON catalog.product_discounts (starts_at, ends_at)
  WHERE is_active;

-- 12. reviews
CREATE TABLE IF NOT EXISTS catalog.reviews (
  id uuid DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  user_id uuid NOT NULL,
  rating smallint NOT NULL,
  title varchar(255),
  body text,
  is_approved boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT reviews_pkey PRIMARY KEY (id),
  CONSTRAINT reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reviews_product_approved
  ON catalog.reviews (product_id)
  WHERE is_approved;

CREATE INDEX IF NOT EXISTS idx_reviews_user_id
  ON catalog.reviews (user_id);

-- 13. triggers for updated_at
CREATE OR REPLACE FUNCTION catalog.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_categories_updated_at ON catalog.categories;
CREATE TRIGGER trg_categories_updated_at
BEFORE UPDATE ON catalog.categories
FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

DROP TRIGGER IF EXISTS trg_brands_updated_at ON catalog.brands;
CREATE TRIGGER trg_brands_updated_at
BEFORE UPDATE ON catalog.brands
FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

DROP TRIGGER IF EXISTS trg_products_updated_at ON catalog.products;
CREATE TRIGGER trg_products_updated_at
BEFORE UPDATE ON catalog.products
FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

DROP TRIGGER IF EXISTS trg_product_variants_updated_at ON catalog.product_variants;
CREATE TRIGGER trg_product_variants_updated_at
BEFORE UPDATE ON catalog.product_variants
FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

DROP TRIGGER IF EXISTS trg_product_options_updated_at ON catalog.product_options;
CREATE TRIGGER trg_product_options_updated_at
BEFORE UPDATE ON catalog.product_options
FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

DROP TRIGGER IF EXISTS trg_product_discounts_updated_at ON catalog.product_discounts;
CREATE TRIGGER trg_product_discounts_updated_at
BEFORE UPDATE ON catalog.product_discounts
FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

COMMIT;

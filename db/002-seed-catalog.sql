BEGIN;

-- Categories
INSERT INTO catalog.categories (id, parent_id, name, slug, description, is_active, show_in_navbar, show_in_megamenu, sort_order)
VALUES 
  ('0190a8b0-0000-7000-8000-000000000001', NULL, 'Apparel', 'apparel', 'Quality clothing and accessories', true, true, true, 1),
  ('0190a8b0-0000-7000-8000-000000000002', NULL, 'Living', 'living', 'Home decor and kitchenware', true, true, true, 2),
  ('0190a8b0-0000-7000-8000-000000000003', '0190a8b0-0000-7000-8000-000000000001', 'T-Shirts', 't-shirts', 'Graphic and essential tees', true, false, true, 1),
  ('0190a8b0-0000-7000-8000-000000000004', '0190a8b0-0000-7000-8000-000000000002', 'Mugs', 'mugs', 'Ceramic and insulated drinkware', true, false, true, 1)
ON CONFLICT (slug) DO NOTHING;

-- Brands
INSERT INTO catalog.brands (id, name, slug, description, is_active, sort_order)
VALUES
  ('0190a8b0-0000-7000-8000-000000000011', 'Acme Essentials', 'acme-essentials', 'Modern daily apparel essentials', true, 1),
  ('0190a8b0-0000-7000-8000-000000000012', 'Artisan Living', 'artisan-living', 'Handcrafted goods for modern homes', true, 2)
ON CONFLICT (slug) DO NOTHING;

-- Products
INSERT INTO catalog.products (id, sku, name, slug, short_description, description, category_id, brand_id, price, stock, status)
VALUES
  (
    '0190a8b0-0000-7000-8000-000000000101',
    'TEE-MAIN',
    'Fixture Tee',
    'fixture-tee',
    'Heavyweight organic cotton crewneck tee.',
    'Crafted from 100% organic cotton, the Fixture Tee features a relaxed fit with reinforced seams.',
    '0190a8b0-0000-7000-8000-000000000003',
    '0190a8b0-0000-7000-8000-000000000011',
    79.99,
    150,
    'active'
  ),
  (
    '0190a8b0-0000-7000-8000-000000000102',
    'MUG-001',
    'Fixture Mug',
    'fixture-mug',
    '12oz matte ceramic coffee mug.',
    'Double-walled minimalist ceramic mug designed to keep coffee warm and comfortable in hand.',
    '0190a8b0-0000-7000-8000-000000000004',
    '0190a8b0-0000-7000-8000-000000000012',
    12.50,
    200,
    'active'
  ),
  (
    '0190a8b0-0000-7000-8000-000000000103',
    'LAMP-DISC',
    'Discontinued Lamp',
    'discontinued-lamp',
    'Archived vintage desk lamp.',
    'No longer in production.',
    '0190a8b0-0000-7000-8000-000000000002',
    '0190a8b0-0000-7000-8000-000000000012',
    45.00,
    0,
    'archived'
  )
ON CONFLICT (slug) DO NOTHING;

-- Product Variants
INSERT INTO catalog.product_variants (id, product_id, sku, price, stock, is_active)
VALUES
  (
    '0190a8b0-0000-7000-8000-000000000201',
    '0190a8b0-0000-7000-8000-000000000101',
    'TEE-BLK-M',
    79.99,
    100,
    true
  ),
  (
    '0190a8b0-0000-7000-8000-000000000202',
    '0190a8b0-0000-7000-8000-000000000101',
    'TEE-WHT-L',
    79.99,
    50,
    true
  )
ON CONFLICT (sku) DO NOTHING;

-- Product Options
INSERT INTO catalog.product_options (id, product_id, name, position)
VALUES
  ('0190a8b0-0000-7000-8000-000000000301', '0190a8b0-0000-7000-8000-000000000101', 'Color', 0),
  ('0190a8b0-0000-7000-8000-000000000302', '0190a8b0-0000-7000-8000-000000000101', 'Size', 1)
ON CONFLICT DO NOTHING;

-- Product Option Values
INSERT INTO catalog.product_option_values (id, option_id, value, position)
VALUES
  ('0190a8b0-0000-7000-8000-000000000311', '0190a8b0-0000-7000-8000-000000000301', 'Black', 0),
  ('0190a8b0-0000-7000-8000-000000000312', '0190a8b0-0000-7000-8000-000000000301', 'White', 1),
  ('0190a8b0-0000-7000-8000-000000000313', '0190a8b0-0000-7000-8000-000000000302', 'M', 0),
  ('0190a8b0-0000-7000-8000-000000000314', '0190a8b0-0000-7000-8000-000000000302', 'L', 1)
ON CONFLICT (option_id, value) DO NOTHING;

-- Product Variant Option Values (Junction)
INSERT INTO catalog.product_variant_option_values (variant_id, option_id, option_value_id)
VALUES
  -- TEE-BLK-M: Black / M
  ('0190a8b0-0000-7000-8000-000000000201', '0190a8b0-0000-7000-8000-000000000301', '0190a8b0-0000-7000-8000-000000000311'),
  ('0190a8b0-0000-7000-8000-000000000201', '0190a8b0-0000-7000-8000-000000000302', '0190a8b0-0000-7000-8000-000000000313'),
  -- TEE-WHT-L: White / L
  ('0190a8b0-0000-7000-8000-000000000202', '0190a8b0-0000-7000-8000-000000000301', '0190a8b0-0000-7000-8000-000000000312'),
  ('0190a8b0-0000-7000-8000-000000000202', '0190a8b0-0000-7000-8000-000000000302', '0190a8b0-0000-7000-8000-000000000314')
ON CONFLICT DO NOTHING;

-- Product Images
INSERT INTO catalog.product_images (id, product_id, variant_id, url, alt, sort_order, is_primary)
VALUES
  ('0190a8b0-0000-7000-8000-000000000401', '0190a8b0-0000-7000-8000-000000000101', NULL, '/images/fixture-tee.jpg', 'Fixture Tee Front View', 0, true),
  ('0190a8b0-0000-7000-8000-000000000402', '0190a8b0-0000-7000-8000-000000000102', NULL, '/images/fixture-mug.jpg', 'Fixture Ceramic Mug', 0, true)
ON CONFLICT DO NOTHING;

-- Initial Stock Movements
INSERT INTO catalog.stock_movements (id, product_id, variant_id, qty_change, reason, qty_after)
VALUES
  ('0190a8b0-0000-7000-8000-000000000501', '0190a8b0-0000-7000-8000-000000000101', '0190a8b0-0000-7000-8000-000000000201', 100, 'restock', 100),
  ('0190a8b0-0000-7000-8000-000000000502', '0190a8b0-0000-7000-8000-000000000101', '0190a8b0-0000-7000-8000-000000000202', 50, 'restock', 50),
  ('0190a8b0-0000-7000-8000-000000000503', '0190a8b0-0000-7000-8000-000000000102', NULL, 200, 'restock', 200)
ON CONFLICT DO NOTHING;

COMMIT;

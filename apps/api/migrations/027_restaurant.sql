-- Restaurants and cafés: tables, orders eaten in / taken away / delivered, notes on a dish,
-- tickets for the kitchen screen, and recipes that take the ingredients out of stock.
CREATE TABLE dining_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  area text,
  seats int NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 50),
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (store_id, name)
);

ALTER TABLE sales ADD COLUMN order_type text CHECK (order_type IN ('dine_in', 'takeaway', 'delivery'));
ALTER TABLE sales ADD COLUMN table_name text;
ALTER TABLE sale_lines ADD COLUMN note text;

-- What the till sent to the kitchen. The id is made on the till, so sending twice is safe.
CREATE TABLE kitchen_tickets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id),
  user_id uuid REFERENCES users(id),
  label text NOT NULL,
  order_type text NOT NULL DEFAULT 'takeaway' CHECK (order_type IN ('dine_in', 'takeaway', 'delivery')),
  table_name text,
  lines jsonb NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'ready', 'served')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- When the kitchen marked it ready: how long orders take.
  ready_at timestamptz
);
CREATE INDEX kitchen_tickets_open ON kitchen_tickets (store_id, status, created_at);

-- A dish and what goes into one of it, in the ingredient's base unit (grams of meat, ml of milk).
CREATE TABLE recipe_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES products(id),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  PRIMARY KEY (product_id, ingredient_id),
  CHECK (product_id <> ingredient_id)
);
CREATE INDEX recipe_lines_tenant ON recipe_lines (tenant_id);

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_kind_check;
ALTER TABLE devices ADD CONSTRAINT devices_kind_check CHECK (kind IN ('pos', 'price_checker', 'kitchen'));

CREATE FUNCTION pos_restaurant_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('وجبات', '🍽️', 1), ('سندويتشات', '🥪', 2), ('بيتزا ومعجنات', '🍕', 3), ('مشاوي', '🍢', 4),
    ('مقبلات وسلطات', '🥗', 5), ('مشروبات ساخنة', '☕', 6), ('عصائر ومشروبات باردة', '🥤', 7), ('حلويات', '🍰', 8),
    ('مواد خام', '📦', 9)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

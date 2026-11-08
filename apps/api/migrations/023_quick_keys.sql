-- Till quick keys: the bread, the water, the bag... one tap away. Each key sells a product in a
-- chosen unit and quantity ("خبز × 5"), or asks the price (open price, for mixed vegetables).
-- Keys sit in groups, have a colour or a small picture, and can be for one branch or one cashier.
CREATE TABLE IF NOT EXISTS quick_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color text,
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quick_groups_tenant ON quick_groups (tenant_id, sort);

CREATE TABLE IF NOT EXISTS quick_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id uuid REFERENCES quick_groups(id) ON DELETE SET NULL,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit_id uuid REFERENCES product_units(id) ON DELETE SET NULL,
  qty_milli bigint NOT NULL DEFAULT 1000 CHECK (qty_milli > 0),
  -- The cashier types the price each time (the product's own price is ignored).
  open_price boolean NOT NULL DEFAULT false,
  label text CHECK (label IS NULL OR length(label) <= 40),
  color text,
  -- A small picture as a data URL, shrunk in the browser before upload.
  image text CHECK (image IS NULL OR length(image) <= 40000),
  -- Only on this branch's tills / only for this cashier; NULL means everywhere / everyone.
  store_id uuid REFERENCES stores(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quick_keys_tenant ON quick_keys (tenant_id, group_id, sort);

-- Products already ticked as quick keys become keys, in name order.
INSERT INTO quick_keys (tenant_id, product_id, sort)
SELECT p.tenant_id, p.id, (row_number() OVER (PARTITION BY p.tenant_id ORDER BY p.name))::int
FROM products p
WHERE p.quick AND NOT EXISTS (SELECT 1 FROM quick_keys k WHERE k.product_id = p.id);

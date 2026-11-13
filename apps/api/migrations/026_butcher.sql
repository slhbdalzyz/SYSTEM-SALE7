-- Butchers: a carcass (or a side, a box of chicken) cut into the pieces sold over the counter.
-- What goes in, what comes out, and the weight lost on the way; the cost follows the cuts.
CREATE TABLE breakdowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id),
  source_product_id uuid NOT NULL REFERENCES products(id),
  source_qty_milli bigint NOT NULL CHECK (source_qty_milli > 0),
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
  note text,
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX breakdowns_tenant ON breakdowns (tenant_id, created_at DESC);
CREATE TABLE breakdown_lines (
  breakdown_id uuid NOT NULL REFERENCES breakdowns(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
  PRIMARY KEY (breakdown_id, product_id)
);

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN ('sale', 'purchase', 'adjust', 'return', 'transfer', 'breakdown'));

CREATE FUNCTION pos_butcher_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('ذبائح كاملة', '🐑', 1), ('لحم غنمي', '🥩', 2), ('لحم بقري', '🐄', 3), ('دجاج', '🍗', 4),
    ('مفروم ومتبل', '🍖', 5), ('أحشاء', '🫀', 6), ('مجمدات', '🧊', 7), ('بهارات وإضافات', '🌶️', 8)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

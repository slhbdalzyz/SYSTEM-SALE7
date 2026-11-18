-- Electronics and phone shops: every phone or laptop has its own serial number / IMEI, sold
-- with a warranty, and the shop takes devices in for repair.
ALTER TABLE products ADD COLUMN serialized boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN warranty_months int NOT NULL DEFAULT 0 CHECK (warranty_months BETWEEN 0 AND 120);

-- The numbers of the pieces sold on a line, and until when they are under warranty.
ALTER TABLE sale_lines ADD COLUMN serials text[];
ALTER TABLE sale_lines ADD COLUMN warranty_until date;

-- One row per piece the shop has had: in stock until it is sold, back in stock if returned.
CREATE TABLE product_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  serial text NOT NULL,
  status text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'sold')),
  note text,
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  sold_at timestamptz,
  warranty_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  UNIQUE (tenant_id, serial)
);
CREATE INDEX product_serials_product ON product_serials (product_id, status);

-- Devices left for repair: what is wrong, the price agreed, what was paid, and where it has got to.
CREATE TABLE repairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  number int NOT NULL,
  customer_name text NOT NULL,
  phone text,
  device text NOT NULL,
  serial text,
  problem text NOT NULL,
  accessories text,
  estimate_minor bigint NOT NULL DEFAULT 0 CHECK (estimate_minor >= 0),
  deposit_minor bigint NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  final_minor bigint CHECK (final_minor >= 0),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'working', 'waiting_parts', 'ready', 'delivered', 'cancelled')),
  notes text,
  technician text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  delivered_at timestamptz,
  created_by uuid REFERENCES users(id),
  UNIQUE (tenant_id, number)
);
CREATE INDEX repairs_open ON repairs (tenant_id, status, created_at);
CREATE INDEX repairs_serial ON repairs (tenant_id, serial) WHERE serial IS NOT NULL;

CREATE FUNCTION pos_electronics_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('هواتف', '📱', 1), ('تابلت', '📲', 2), ('لابتوب وكمبيوتر', '💻', 3), ('قطع كمبيوتر', '🖥️', 4),
    ('شواحن وكوابل', '🔌', 5), ('سماعات', '🎧', 6), ('جرابات وحماية شاشة', '🛡️', 7), ('ساعات ذكية', '⌚', 8),
    ('شبكات وراوترات', '📡', 9), ('ذواكر وفلاشات', '💾', 10), ('كروت تعبئة', '💳', 11), ('قطع غيار صيانة', '🔧', 12)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

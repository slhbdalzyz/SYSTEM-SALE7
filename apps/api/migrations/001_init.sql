-- Multi-tenant core schema. Every business row carries tenant_id; the API always filters by it.
-- Money: bigint minor units (dirham). Quantities: bigint thousandths of the base unit.

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'LYD',
  business_type text NOT NULL DEFAULT 'grocery',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text,
  receipt_footer text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stores (tenant_id);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text UNIQUE,
  password_hash text,
  pin_hash text,
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON users (tenant_id);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, prefix)
);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON categories (tenant_id);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  sku text,
  is_weighted boolean NOT NULL DEFAULT false,
  scale_code text,
  tax_bp integer NOT NULL DEFAULT 0,
  cost_minor bigint NOT NULL DEFAULT 0,
  min_stock_milli bigint NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scale_code)
);
CREATE INDEX ON products (tenant_id, updated_at);

CREATE TABLE product_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  factor_milli bigint NOT NULL DEFAULT 1000,
  price_minor bigint NOT NULL,
  is_base boolean NOT NULL DEFAULT false
);
CREATE INDEX ON product_units (product_id);

CREATE TABLE barcodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES product_units(id) ON DELETE CASCADE,
  code text NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE shifts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  user_id uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  opening_cash_minor bigint NOT NULL DEFAULT 0,
  closing_cash_minor bigint,
  expected_cash_minor bigint
);
CREATE INDEX ON shifts (tenant_id, device_id) WHERE closed_at IS NULL;

CREATE TABLE sales (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  shift_id uuid REFERENCES shifts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  number text NOT NULL,
  subtotal_minor bigint NOT NULL,
  discount_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  total_minor bigint NOT NULL,
  paid_minor bigint NOT NULL,
  change_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX ON sales (tenant_id, store_id, created_at);

CREATE TABLE sale_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  unit_id uuid NOT NULL REFERENCES product_units(id),
  name text NOT NULL,
  qty_milli bigint NOT NULL,
  price_minor bigint NOT NULL,
  discount_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  total_minor bigint NOT NULL,
  cost_minor bigint NOT NULL DEFAULT 0
);
CREATE INDEX ON sale_lines (sale_id);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('cash', 'card', 'credit')),
  amount_minor bigint NOT NULL
);
CREATE INDEX ON payments (sale_id);

-- Stock is never stored as a number to edit; it is the sum of movements.
CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_milli bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sale', 'purchase', 'adjust', 'return', 'transfer')),
  ref_id uuid,
  note text,
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stock_movements (tenant_id, store_id, product_id);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid,
  device_id uuid,
  action text NOT NULL,
  entity text,
  entity_id uuid,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (tenant_id, created_at);

-- The audit log is append-only.
CREATE FUNCTION audit_log_readonly() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();

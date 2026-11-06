-- Quick keys on the till, and item variants (sizes and colours) sharing a group.
ALTER TABLE products ADD COLUMN quick boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN group_id uuid;
ALTER TABLE products ADD COLUMN attrs jsonb;
CREATE INDEX products_group ON products (tenant_id, group_id) WHERE group_id IS NOT NULL;

-- Stock counts: items counted on a phone, then applied as corrections in one go.
CREATE TABLE stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'cancelled')),
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_by uuid REFERENCES users(id),
  applied_at timestamptz
);
CREATE INDEX ON stock_counts (tenant_id, created_at);
CREATE TABLE stock_count_lines (
  count_id uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  counted_milli bigint NOT NULL CHECK (counted_milli >= 0),
  system_milli bigint,
  counted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (count_id, product_id)
);

-- A second step at sign-in: a code from an authenticator app.
ALTER TABLE users ADD COLUMN totp_secret text;
ALTER TABLE users ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false;

-- Server errors, for the platform's back office.
CREATE TABLE server_errors (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  method text,
  url text,
  tenant_id uuid,
  message text,
  stack text
);
CREATE INDEX ON server_errors (at);

-- A clothing shop starts with clothing departments instead of grocery ones.
CREATE FUNCTION pos_clothing_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('رجالي', '👔', 1), ('نسائي', '👗', 2), ('أطفال', '🧒', 3), ('أحذية', '👟', 4),
    ('شنط وإكسسوارات', '👜', 5), ('ملابس داخلية', '🧦', 6), ('رياضي', '🏃', 7)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

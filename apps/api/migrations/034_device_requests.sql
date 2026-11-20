-- A cashier can get a new till device in without the owner standing there:
--  * the shop code (6 digits, in «الأجهزة») plus the cashier's own PIN asks for the device,
--    and the owner approves it from the phone (or the shop lets such devices in by itself);
--  * or the owner sends a one-time link (15 minutes) on WhatsApp that approves the device it is opened on.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shop_code text UNIQUE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS device_auto_approve boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS device_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- The token the asking device holds; on approval the new device gets this same hash.
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS device_requests_pending ON device_requests (tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS device_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'pos' CHECK (kind IN ('pos', 'price_checker', 'kitchen')),
  code_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_kind_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN ('low_stock', 'out_of_stock', 'big_return', 'big_discount', 'cash_diff', 'over_credit_limit', 'zakat_due', 'subscription_due', 'support_reply', 'announcement', 'expiry_soon', 'device_request'));

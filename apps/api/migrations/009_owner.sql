-- What the owner sees from the phone: alerts about the shop, where to push them, money spent
-- outside sales (rent, power, wages) for a real profit figure, and which tills keep a backup.

-- Each shop picks what is worth an alert. Amounts in dirham; 0 turns that alert off.
ALTER TABLE tenants ADD COLUMN alert_settings jsonb NOT NULL DEFAULT
  '{"lowStock": true, "returnOverMinor": 50000, "discountOverMinor": 20000, "cashDiffOverMinor": 5000, "overCreditLimit": true}';

CREATE TABLE alerts (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('low_stock', 'out_of_stock', 'big_return', 'big_discount', 'cash_diff', 'over_credit_limit')),
  title text NOT NULL,
  body text NOT NULL,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  pushed_at timestamptz -- sent to the phones; NULL while waiting or when push is not set up
);
CREATE INDEX alerts_tenant ON alerts (tenant_id, id DESC);
CREATE INDEX alerts_unread ON alerts (tenant_id) WHERE read_at IS NULL;

-- A phone (or browser) that asked for notifications, for one owner or manager.
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_tenant ON push_subscriptions (tenant_id);

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id),
  category text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  note text,
  spent_on date NOT NULL,
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_tenant ON expenses (tenant_id, spent_on DESC);

-- The owner allows a till to download the whole shop's data and keep daily copies on its disk.
ALTER TABLE devices ADD COLUMN backup boolean NOT NULL DEFAULT false;

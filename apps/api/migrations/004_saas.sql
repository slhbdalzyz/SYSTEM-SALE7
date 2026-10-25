-- Selling the system: plans, each shop's subscription, the payments it made, and the
-- people who run the platform (not shop staff; they sign in separately).

CREATE TABLE plans (
  code text PRIMARY KEY,
  name text NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0), -- per month
  max_stores int NOT NULL CHECK (max_stores > 0),
  max_devices int NOT NULL CHECK (max_devices > 0),
  max_users int NOT NULL CHECK (max_users > 0),
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0
);

INSERT INTO plans (code, name, price_minor, max_stores, max_devices, max_users, sort) VALUES
  ('basic', 'الأساسية', 150000, 1, 2, 5, 1),
  ('pro', 'المتقدمة', 300000, 3, 8, 20, 2),
  ('chain', 'السلاسل', 700000, 20, 60, 200, 3);

-- paid_until is the end of the trial or of the last paid period. Past it the shop gets a
-- few days' grace, then locks until it pays (see src/billing.ts).
ALTER TABLE tenants
  ADD COLUMN plan_code text NOT NULL DEFAULT 'basic' REFERENCES plans(code),
  ADD COLUMN status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'suspended', 'cancelled')),
  ADD COLUMN paid_until timestamptz NOT NULL DEFAULT now() + interval '14 days',
  ADD COLUMN status_reason text,
  ADD COLUMN phone text;

-- Shops that existed before billing keep working for a month.
UPDATE tenants SET status = 'active', paid_until = now() + interval '30 days';

CREATE TABLE platform_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES plans(code),
  months int NOT NULL CHECK (months BETWEEN 1 AND 36),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  method text NOT NULL CHECK (method IN ('cash', 'bank', 'card', 'other')),
  reference text,
  period_from timestamptz NOT NULL,
  period_to timestamptz NOT NULL,
  recorded_by uuid NOT NULL REFERENCES platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_payments_tenant ON subscription_payments (tenant_id, created_at DESC);

CREATE TABLE platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
INSERT INTO platform_settings (key, value) VALUES
  ('payment_instructions', '"حوّل قيمة الاشتراك على الحساب المصرفي وابعتلنا صورة الإيصال، أو ادفع كاش في مكتبنا."'),
  ('grace_days', '7');

-- What platform staff did to which shop. Append-only, like the shops' own audit log.
CREATE TABLE platform_audit (
  id bigserial PRIMARY KEY,
  admin_id uuid REFERENCES platform_admins(id),
  tenant_id uuid, -- no foreign key: the row must outlive anything it describes
  action text NOT NULL,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER platform_audit_no_update BEFORE UPDATE OR DELETE ON platform_audit
  FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();

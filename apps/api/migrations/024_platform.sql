-- The platform back office grows into a company's: a team with roles and two-step sign-in, agents
-- in the cities, coupons, invoices, renewal reminders, announcements, support tickets, support
-- access with the shop's consent, and features opened or closed per plan or per shop.

ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner'
  CHECK (role IN ('owner', 'manager', 'accountant', 'support', 'agent'));
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Agents sell the service in their city and earn a share of what their shops pay.
CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  city text,
  -- Shops that sign up with this code (or link) are the agent's.
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{3,12}$'),
  -- Commission in basis points of each payment: 1000 = 10%.
  commission_bp int NOT NULL DEFAULT 1000 CHECK (commission_bp BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id);

CREATE TABLE IF NOT EXISTS agent_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  note text,
  paid_by uuid REFERENCES platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,30}$'),
  kind text NOT NULL CHECK (kind IN ('percent', 'months')),
  value int NOT NULL CHECK (value > 0),
  plan_code text REFERENCES plans(code),
  min_months int NOT NULL DEFAULT 1 CHECK (min_months BETWEEN 1 AND 36),
  max_uses int CHECK (max_uses IS NULL OR max_uses > 0),
  used int NOT NULL DEFAULT 0,
  valid_until timestamptz,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'percent' OR value <= 100)
);
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coupons(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES subscription_payments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coupon_id, tenant_id)
);

-- Every subscription payment gets an invoice number, in order, never reused.
CREATE SEQUENCE IF NOT EXISTS subscription_invoice_no START 1001;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS invoice_no bigint;
UPDATE subscription_payments SET invoice_no = n.no FROM (
  SELECT id, nextval('subscription_invoice_no') AS no FROM (SELECT id FROM subscription_payments WHERE invoice_no IS NULL ORDER BY created_at, id) o
) n WHERE n.id = subscription_payments.id;
ALTER TABLE subscription_payments ALTER COLUMN invoice_no SET DEFAULT nextval('subscription_invoice_no');
CREATE UNIQUE INDEX IF NOT EXISTS subscription_payments_invoice ON subscription_payments (invoice_no);
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS coupon_code text;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS discount_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS bonus_months int NOT NULL DEFAULT 0;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS coupon_code text;

-- Renewal reminders: one per shop, kind and period end. Sent by SMS when a gateway is set,
-- otherwise waiting for a one-tap WhatsApp from the platform.
CREATE TABLE IF NOT EXISTS subscription_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('7d', '3d', 'locked')),
  period_end date NOT NULL,
  message text NOT NULL,
  sent_at timestamptz,
  channel text CHECK (channel IN ('sms', 'whatsapp', 'skipped')),
  sent_by uuid REFERENCES platform_admins(id),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, period_end)
);

CREATE TABLE IF NOT EXISTS announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'promo')),
  -- Who sees it: everyone when both are NULL; else shops on these plans, or these shops.
  plans text[],
  tenant_ids uuid[],
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS announcement_dismissals (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigserial UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  subject text NOT NULL CHECK (length(subject) BETWEEN 3 AND 150),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  assigned_to uuid REFERENCES platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets (status, updated_at DESC);
CREATE TABLE IF NOT EXISTS support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author text NOT NULL CHECK (author IN ('shop', 'platform')),
  user_id uuid REFERENCES users(id),
  admin_id uuid REFERENCES platform_admins(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Support access: until when the owner lets the platform look at the shop (read only).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS support_until timestamptz;

-- Features opened or closed: per plan, and per shop over its plan.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}';

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_kind_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN ('low_stock', 'out_of_stock', 'big_return', 'big_discount', 'cash_diff', 'over_credit_limit', 'zakat_due', 'subscription_due', 'support_reply', 'announcement'));

INSERT INTO platform_settings (key, value) VALUES
  ('reminder_message', '"السلام عليكم، اشتراك «{shop}» في منظومة البيع ينتهي يوم {date} (باقي {days} يوم). باش يكمل النظام يخدم من غير توقف، جدّد من صفحة «الاشتراك» أو تواصل معانا. قيمة الباقة {price}."'),
  ('company', '{"name": "Sale7 POS", "phone": "", "address": "طرابلس، ليبيا", "taxNo": ""}')
ON CONFLICT (key) DO NOTHING;

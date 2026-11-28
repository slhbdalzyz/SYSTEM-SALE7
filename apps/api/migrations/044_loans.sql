-- Cash lent from the drawer (سلفة) and money a person leaves with the shop (أمانة), with every
-- payment back or withdrawal. Each move that touched a drawer has its drawer_moves row, so the
-- shift and the treasury count it; one recorded away from a till (the owner's page) counts in the
-- treasury's cash by itself.
CREATE TABLE loans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('loan', 'deposit')),
  person_name text NOT NULL,
  phone text,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  due_on date,
  note text,
  -- pending: over the cashier's limit, waiting for the owner; approved: the owner said yes and the
  -- till has not paid it out yet; open: money handed over; closed: all back; rejected.
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('pending', 'approved', 'open', 'closed', 'rejected')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX loans_tenant ON loans (tenant_id, status, created_at);

CREATE TABLE loan_moves (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  loan_id uuid NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  -- open: the money first handed over (out for a loan, in for a deposit); back: paid back or withdrawn.
  kind text NOT NULL CHECK (kind IN ('open', 'back')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  drawer_move_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_moves_loan ON loan_moves (loan_id);
CREATE INDEX loan_moves_tenant ON loan_moves (tenant_id, created_at);

-- Which drawer moves are a loan's, so the shift report shows them apart from other cash in and out.
ALTER TABLE drawer_moves ADD COLUMN loan_id uuid;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_kind_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN ('low_stock', 'out_of_stock', 'big_return', 'big_discount', 'cash_diff', 'over_credit_limit', 'zakat_due', 'subscription_due', 'support_reply', 'announcement', 'expiry_soon', 'device_request', 'shift_forgotten', 'loan_request', 'loan_due'));

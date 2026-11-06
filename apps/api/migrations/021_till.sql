-- The till takes Libyan ways of paying besides cash and card: Sadad, Edfali, MobiCash, a cheque or
-- a bank transfer.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('cash', 'card', 'credit', 'payroll', 'sadad', 'edfali', 'mobicash', 'cheque', 'transfer'));

-- Money put into or taken out of a till's drawer during a shift (change brought in, a supplier paid
-- from the drawer, the owner taking cash home), each with its reason. The till makes the id, so a
-- move made offline is sent later, once.
CREATE TABLE drawer_moves (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id),
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('in', 'out')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drawer_moves_tenant ON drawer_moves (tenant_id, created_at);
CREATE INDEX drawer_moves_shift ON drawer_moves (shift_id);

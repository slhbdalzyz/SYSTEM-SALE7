-- Loyalty points: customers earn points on what they buy and spend them at the till.
-- A customer's points are the sum of their ledger rows, like stock is the sum of movements.

ALTER TABLE tenants ADD COLUMN loyalty jsonb NOT NULL DEFAULT
  '{"enabled": false, "earnMinorPerPoint": 1000, "pointValueMinor": 10, "minRedeemPoints": 100}';

-- Paying with points is a payment like any other; its amount is what the points were worth.
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('cash', 'card', 'credit', 'points'));

CREATE TABLE loyalty_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  points bigint NOT NULL CHECK (points <> 0),
  -- earn: from a sale; redeem: spent on a sale; return: a return takes back what it earned and
  -- gives back what was spent; adjust: set by a manager by hand.
  kind text NOT NULL CHECK (kind IN ('earn', 'redeem', 'return', 'adjust')),
  sale_id uuid REFERENCES sales(id) ON DELETE CASCADE,
  note text,
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_entries_customer ON loyalty_entries (customer_id, created_at);
CREATE INDEX loyalty_entries_sale ON loyalty_entries (sale_id);

-- Customers with credit (آجل), and returns.
-- A return is a row in sales with kind = 'return' and negative amounts, so totals,
-- profit, cash in the drawer and stock all net out without special cases.

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  note text,
  -- NULL: no limit. 0: credit not allowed.
  credit_limit_minor bigint,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);
CREATE INDEX ON customers (tenant_id, updated_at);

-- Money a customer brings in to pay down their balance.
CREATE TABLE customer_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  device_id uuid REFERENCES devices(id),
  shift_id uuid REFERENCES shifts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  method text NOT NULL CHECK (method IN ('cash', 'card')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON customer_payments (customer_id);

ALTER TABLE sales
  ADD COLUMN customer_id uuid REFERENCES customers(id),
  ADD COLUMN kind text NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale', 'return')),
  ADD COLUMN original_sale_id uuid REFERENCES sales(id),
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN reason text;
CREATE INDEX ON sales (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX ON sales (original_sale_id) WHERE original_sale_id IS NOT NULL;

-- Which original line a returned line undoes, to stop returning more than was sold.
ALTER TABLE sale_lines ADD COLUMN original_line_id uuid REFERENCES sale_lines(id);
CREATE INDEX ON sale_lines (original_line_id) WHERE original_line_id IS NOT NULL;

-- Balance = credit given on sales (minus credit refunded on returns) − payments received.
CREATE VIEW customer_balances AS
SELECT c.id AS customer_id, c.tenant_id,
  COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales s ON s.id = p.sale_id
            WHERE s.customer_id = c.id AND p.method = 'credit'), 0)
  - COALESCE((SELECT sum(cp.amount_minor) FROM customer_payments cp WHERE cp.customer_id = c.id), 0) AS balance_minor
FROM customers c;

-- Buying from suppliers: who we buy from, what each invoice brought in, and what we still owe.

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX suppliers_tenant ON suppliers (tenant_id, name);

-- The id is also the ref_id of the stock movements the invoice made.
CREATE TABLE purchase_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id),
  supplier_id uuid REFERENCES suppliers(id),
  supplier_ref text, -- the number printed on the supplier's invoice
  invoice_date date NOT NULL DEFAULT current_date,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  note text,
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_invoices_tenant ON purchase_invoices (tenant_id, created_at DESC);
CREATE INDEX purchase_invoices_supplier ON purchase_invoices (supplier_id);

CREATE TABLE purchase_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  unit_id uuid NOT NULL REFERENCES product_units(id),
  name text NOT NULL,
  unit_name text NOT NULL,
  qty_milli bigint NOT NULL CHECK (qty_milli > 0), -- in the unit bought (cartons, kg…)
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
  total_minor bigint NOT NULL
);
CREATE INDEX purchase_lines_invoice ON purchase_lines (invoice_id);

-- Money paid to a supplier, at the time of an invoice or later.
CREATE TABLE supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  invoice_id uuid REFERENCES purchase_invoices(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  method text NOT NULL CHECK (method IN ('cash', 'bank', 'cheque', 'other')),
  note text,
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_payments_supplier ON supplier_payments (supplier_id);

-- What we owe each supplier: invoices minus payments. Positive = we owe them.
CREATE VIEW supplier_balances AS
SELECT s.id AS supplier_id, s.tenant_id,
       COALESCE((SELECT sum(total_minor) FROM purchase_invoices i WHERE i.supplier_id = s.id), 0)
     - COALESCE((SELECT sum(amount_minor) FROM supplier_payments p WHERE p.supplier_id = s.id), 0) AS balance_minor
FROM suppliers s;

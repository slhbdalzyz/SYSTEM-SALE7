-- Starting from paper: what each customer already owed, and what the shop already owed each
-- supplier, on the day the shop moved to the system. Counted in the balances like any invoice.
ALTER TABLE customers ADD COLUMN opening_balance_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN opening_balance_minor bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE VIEW customer_balances AS
SELECT c.id AS customer_id, c.tenant_id,
  c.opening_balance_minor
  + COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales s ON s.id = p.sale_id
            WHERE s.customer_id = c.id AND p.method = 'credit'), 0)
  - COALESCE((SELECT sum(cp.amount_minor) FROM customer_payments cp WHERE cp.customer_id = c.id), 0) AS balance_minor
FROM customers c;

CREATE OR REPLACE VIEW supplier_balances AS
SELECT s.id AS supplier_id, s.tenant_id,
       s.opening_balance_minor
     + COALESCE((SELECT sum(total_minor) FROM purchase_invoices i WHERE i.supplier_id = s.id), 0)
     - COALESCE((SELECT sum(amount_minor) FROM supplier_payments p WHERE p.supplier_id = s.id), 0) AS balance_minor
FROM suppliers s;

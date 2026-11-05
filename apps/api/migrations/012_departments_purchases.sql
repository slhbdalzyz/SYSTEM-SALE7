-- 1. Loyalty points are gone. (Any till payment made with points becomes cash, so the payment
--    rows still add up to the sale total; real shops never had points switched on.)
DROP TABLE IF EXISTS loyalty_entries;
ALTER TABLE tenants DROP COLUMN IF EXISTS loyalty;
UPDATE payments SET method = 'cash' WHERE method = 'points';
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('cash', 'card', 'credit'));

-- 2. Departments (meat, vegetables, dairy…): the existing categories, with an order and an icon.
ALTER TABLE categories ADD COLUMN sort integer NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN icon text;
ALTER TABLE categories ADD CONSTRAINT categories_name_unique UNIQUE (tenant_id, name);

-- The usual grocery departments, for every shop that has none yet. New shops get them at sign-up.
CREATE FUNCTION pos_default_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('اللحوم والدواجن', '🥩', 1), ('الخضروات والفواكه', '🥬', 2), ('الألبان والأجبان', '🧀', 3),
    ('المخبوزات', '🍞', 4), ('المواد الغذائية', '🍚', 5), ('المعلبات', '🥫', 6),
    ('المشروبات', '🥤', 7), ('الحلويات والسناكس', '🍫', 8), ('المجمدات', '🧊', 9),
    ('المنظفات', '🧴', 10), ('العناية الشخصية', '🧼', 11)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;
SELECT pos_default_departments(t.id) FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.tenant_id = t.id);

-- 3. Supply invoices: how they were paid (credit = all owed to the supplier), and per line the
--    selling price set when the goods came in and the expiry date, if there is one.
ALTER TABLE purchase_invoices ADD COLUMN payment_method text NOT NULL DEFAULT 'cash'
  CHECK (payment_method IN ('credit', 'cash', 'card', 'transfer', 'cheque'));
UPDATE purchase_invoices i SET payment_method = 'credit'
  WHERE i.supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_payments p WHERE p.invoice_id = i.id);

ALTER TABLE purchase_lines ADD COLUMN sell_price_minor bigint CHECK (sell_price_minor >= 0);
ALTER TABLE purchase_lines ADD COLUMN expiry_date date;
CREATE INDEX purchase_lines_expiry ON purchase_lines (tenant_id, expiry_date) WHERE expiry_date IS NOT NULL;

-- Paying a supplier: a bank transfer and a bank card are now told apart ('bank' was the transfer).
UPDATE supplier_payments SET method = 'transfer' WHERE method = 'bank';
ALTER TABLE supplier_payments DROP CONSTRAINT supplier_payments_method_check;
ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_method_check CHECK (method IN ('cash', 'card', 'transfer', 'cheque', 'other'));

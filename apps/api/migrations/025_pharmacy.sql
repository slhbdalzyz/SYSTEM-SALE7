-- Pharmacies: the scientific name a medicine is known by (to find it and its alternatives), and
-- whether it is sold only against a prescription.
ALTER TABLE products ADD COLUMN generic_name text;
ALTER TABLE products ADD COLUMN rx boolean NOT NULL DEFAULT false;
CREATE INDEX products_generic ON products (tenant_id, lower(generic_name)) WHERE generic_name IS NOT NULL;

-- The prescription the cashier saw, on a sale with a prescription-only medicine.
ALTER TABLE sales ADD COLUMN prescription jsonb;
CREATE INDEX sales_prescription ON sales (tenant_id, created_at) WHERE prescription IS NOT NULL;

-- Medicines close to their expiry date: one alert a day at most.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_kind_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN ('low_stock', 'out_of_stock', 'big_return', 'big_discount', 'cash_diff', 'over_credit_limit', 'zakat_due', 'subscription_due', 'support_reply', 'announcement', 'expiry_soon'));

CREATE FUNCTION pos_pharmacy_departments(tid uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO categories (tenant_id, name, icon, sort)
  SELECT tid, d.name, d.icon, d.sort FROM (VALUES
    ('أدوية بوصفة', '💊', 1), ('أدوية بدون وصفة', '🩹', 2), ('مسكنات وبرد', '🤧', 3), ('أطفال ورضع', '🍼', 4),
    ('فيتامينات ومكملات', '💪', 5), ('عناية بالبشرة', '🧴', 6), ('أجهزة ومستلزمات طبية', '🩺', 7), ('عناية شخصية', '🪥', 8)
  ) AS d(name, icon, sort)
  ON CONFLICT (tenant_id, name) DO NOTHING;
$$;

-- Same as the loyalty part of 012, for a database where an older server put the loyalty
-- column and table back after 012 ran (a preview build migrated the live database early).
DROP TABLE IF EXISTS loyalty_entries;
ALTER TABLE tenants DROP COLUMN IF EXISTS loyalty;
UPDATE payments SET method = 'cash' WHERE method = 'points';
UPDATE supplier_payments SET method = 'transfer' WHERE method = 'bank';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('cash', 'card', 'credit'));
ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_method_check;
ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_method_check CHECK (method IN ('cash', 'card', 'transfer', 'cheque', 'other'));

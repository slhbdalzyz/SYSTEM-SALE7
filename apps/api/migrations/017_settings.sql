-- The shop's settings page: contact details, bank account, what the receipt shows, how the till
-- behaves. One JSON document per shop, read through shopSettingsSchema so missing keys get defaults.
ALTER TABLE tenants ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';

-- Listing invoices by shift and by time.
CREATE INDEX IF NOT EXISTS sales_shift ON sales (shift_id);
CREATE INDEX IF NOT EXISTS sales_tenant_created ON sales (tenant_id, created_at DESC);

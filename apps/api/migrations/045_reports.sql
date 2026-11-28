-- The owner's summary on the phone (daily / weekly / monthly) arrives as an alert.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_kind_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN ('low_stock', 'out_of_stock', 'big_return', 'big_discount', 'cash_diff', 'over_credit_limit', 'zakat_due', 'subscription_due', 'support_reply', 'announcement', 'expiry_soon', 'device_request', 'shift_forgotten', 'loan_request', 'loan_due', 'report_digest'));
-- The controls report reads the till's cancelled carts and typed prices by kind and day.
CREATE INDEX IF NOT EXISTS audit_log_tenant_action ON audit_log (tenant_id, action, created_at);

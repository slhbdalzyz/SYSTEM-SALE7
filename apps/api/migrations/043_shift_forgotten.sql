-- An alert for a shift left open more than a day.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_kind_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN ('low_stock', 'out_of_stock', 'big_return', 'big_discount', 'cash_diff', 'over_credit_limit', 'zakat_due', 'subscription_due', 'support_reply', 'announcement', 'expiry_soon', 'device_request', 'shift_forgotten'));

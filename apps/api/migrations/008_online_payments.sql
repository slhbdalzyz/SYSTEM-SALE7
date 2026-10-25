-- Shops paying their own subscription online. An intent is one attempt; it becomes a
-- subscription payment once the gateway confirms the money.
CREATE TABLE payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES plans(code),
  months int NOT NULL CHECK (months BETWEEN 1 AND 36),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  provider text NOT NULL,
  method text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'canceled')),
  invoice_no text NOT NULL UNIQUE, -- what the gateway knows the payment by
  process_id text,
  transaction_id text,
  error text,
  user_id uuid REFERENCES users(id),
  payment_id uuid REFERENCES subscription_payments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payment_intents (tenant_id, created_at DESC);

-- Online payments are recorded by the system, not by a member of staff.
ALTER TABLE subscription_payments ALTER COLUMN recorded_by DROP NOT NULL;
ALTER TABLE subscription_payments DROP CONSTRAINT subscription_payments_method_check;
ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_method_check CHECK (method IN ('cash', 'bank', 'card', 'other', 'online'));

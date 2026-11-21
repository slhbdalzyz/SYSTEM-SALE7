-- The shop's bank accounts (Jumhouria, Wahda, Commerce & Development…), each with its own balance.
-- Money that goes "to the bank" (a transfer, a cheque, a supplier paid from the bank) says which
-- account; card money first waits on the card machine's account ("under settlement") until the
-- bank pays it in, less its commission. Anything that does not name an account belongs to the
-- shop's default account, so nothing recorded before this goes missing.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_name text NOT NULL,
  name text,
  account_number text,
  iban text,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_one_default ON bank_accounts (tenant_id) WHERE is_default;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE money_movements ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL;
-- The card machine on this till pays into this account.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS card_bank_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL;

-- A card settlement moves money from "under settlement" into the bank.
ALTER TABLE money_movements DROP CONSTRAINT IF EXISTS money_movements_kind_check;
ALTER TABLE money_movements ADD CONSTRAINT money_movements_kind_check CHECK (kind IN ('opening', 'deposit', 'withdrawal', 'transfer', 'adjust', 'settlement'));
ALTER TABLE money_movements ADD COLUMN IF NOT EXISTS settlement_id uuid;

-- Ticking off movements against the bank statement, and the statement balances checked.
CREATE TABLE IF NOT EXISTS money_cleared (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  row_key text NOT NULL,
  cleared_by uuid REFERENCES users(id) ON DELETE SET NULL,
  cleared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, row_key)
);
CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  statement_date date NOT NULL,
  statement_minor bigint NOT NULL,
  book_minor bigint NOT NULL,
  cleared_minor bigint NOT NULL,
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_reconciliations_account ON bank_reconciliations (bank_account_id, statement_date DESC);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS settlement_id uuid;

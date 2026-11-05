-- Where the shop's money is: cash, card (the bank account card payments land in) and bank transfer.
-- Every other table already says how money moved (sales, refunds, customer payments, supplier
-- payments, purchases paid on the spot); expenses now say it too.
ALTER TABLE expenses ADD COLUMN payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'transfer'));

-- What the owner records by hand: the starting balance, money put in or taken out, a move from one
-- account to another (two rows sharing transfer_id), or a correction after counting.
CREATE TABLE money_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account text NOT NULL CHECK (account IN ('cash', 'card', 'transfer')),
  kind text NOT NULL CHECK (kind IN ('opening', 'deposit', 'withdrawal', 'transfer', 'adjust')),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  transfer_id uuid,
  note text,
  on_date date NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX money_movements_tenant ON money_movements (tenant_id, on_date);

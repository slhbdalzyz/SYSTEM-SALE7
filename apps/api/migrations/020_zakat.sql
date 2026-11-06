-- Counts that go further: one department at a time, several phones at once, blind (the counter
-- does not see what the books say), with the shop open (each line is compared with the books at
-- the moment it was counted), and damaged or expired goods noted apart and written off.
ALTER TABLE stock_counts ADD COLUMN category_id uuid REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE stock_counts ADD COLUMN blind boolean NOT NULL DEFAULT false;
ALTER TABLE stock_counts ADD COLUMN purpose text NOT NULL DEFAULT 'normal' CHECK (purpose IN ('normal', 'zakat'));
ALTER TABLE stock_count_lines ADD COLUMN damaged_milli bigint NOT NULL DEFAULT 0 CHECK (damaged_milli >= 0);
ALTER TABLE stock_count_lines ADD COLUMN counted_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS stock_movements_at ON stock_movements (store_id, product_id, created_at);

-- Zakat: when the shop's year turns and how goods are valued, and each year's sheet, kept as it
-- was signed off so years can be compared.
ALTER TABLE tenants ADD COLUMN zakat_settings jsonb NOT NULL DEFAULT '{}';
CREATE TABLE zakat_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  year_label text NOT NULL,
  on_date date NOT NULL,
  calendar text NOT NULL CHECK (calendar IN ('hijri', 'gregorian')),
  valuation text NOT NULL CHECK (valuation IN ('cost', 'price')),
  inventory_minor bigint NOT NULL,
  cash_minor bigint NOT NULL,
  receivables_minor bigint NOT NULL,
  other_assets_minor bigint NOT NULL DEFAULT 0,
  payables_minor bigint NOT NULL,
  other_debts_minor bigint NOT NULL DEFAULT 0,
  gold_gram_minor bigint NOT NULL,
  nisab_grams int NOT NULL,
  base_minor bigint NOT NULL,
  rate int NOT NULL,
  zakat_minor bigint NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zakat_reports_tenant ON zakat_reports (tenant_id, on_date DESC);

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_kind_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN ('low_stock', 'out_of_stock', 'big_return', 'big_discount', 'cash_diff', 'over_credit_limit', 'zakat_due'));

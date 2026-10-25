-- Promotions. Devices apply them offline; the server checks the same rules when the sale arrives.
CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent', 'amount', 'buy_get', 'bundle')),
  percent_bp int CHECK (percent_bp BETWEEN 1 AND 10000),
  amount_minor bigint CHECK (amount_minor > 0),
  buy_qty int CHECK (buy_qty > 0),
  get_qty int CHECK (get_qty > 0),
  bundle_qty int CHECK (bundle_qty > 1),
  bundle_price_minor bigint CHECK (bundle_price_minor >= 0),
  product_ids uuid[] NOT NULL DEFAULT '{}',
  category_ids uuid[] NOT NULL DEFAULT '{}',
  store_ids uuid[] NOT NULL DEFAULT '{}',
  starts_at timestamptz,
  ends_at timestamptz,
  days int[] NOT NULL DEFAULT '{}',
  hour_from int CHECK (hour_from BETWEEN 0 AND 23),
  hour_to int CHECK (hour_to BETWEEN 0 AND 24),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON offers (tenant_id, active);

ALTER TABLE sale_lines ADD COLUMN promo_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE sale_lines ADD COLUMN offer_id uuid REFERENCES offers(id);
CREATE INDEX ON sale_lines (offer_id) WHERE offer_id IS NOT NULL;

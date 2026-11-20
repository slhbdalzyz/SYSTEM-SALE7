-- The barcode library: shops that agree to share tell which name goes with a product barcode, so the
-- next shop that scans it gets the name filled in. Only the barcode, the name and the unit: no prices,
-- no quantities. A shop that stops sharing takes its rows out.
CREATE TABLE IF NOT EXISTS barcode_library (
  code text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  unit text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, tenant_id)
);
CREATE INDEX IF NOT EXISTS barcode_library_code ON barcode_library (code);

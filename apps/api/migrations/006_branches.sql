-- Branches: stores can be switched off, and stock moves between them with a transfer.

ALTER TABLE stores ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE stores ADD COLUMN phone text;

-- A transfer leaves the sending branch when it is sent and arrives when the other branch confirms.
-- Stock movements of kind 'transfer' carry the transfer id as ref_id.
CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number int NOT NULL,
  from_store_id uuid NOT NULL REFERENCES stores(id),
  to_store_id uuid NOT NULL REFERENCES stores(id),
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'received', 'cancelled')),
  note text,
  sent_by uuid REFERENCES users(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  done_by uuid REFERENCES users(id),
  done_at timestamptz,
  CHECK (from_store_id <> to_store_id),
  UNIQUE (tenant_id, number)
);
CREATE INDEX ON stock_transfers (tenant_id, status);

CREATE TABLE stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  name text NOT NULL,
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),         -- base units sent
  received_milli bigint CHECK (received_milli >= 0)        -- base units that arrived; less = shortage
);
CREATE INDEX ON stock_transfer_lines (transfer_id);

-- Yearly licences for the desktop's local edition. A shop on its own computer has no account on
-- the cloud: the platform issues it a signed key for its computer's ID, and the app checks the
-- signature with no internet. A renewal is a new row with the same root.
CREATE TABLE desktop_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_id uuid NOT NULL,
  shop_name text NOT NULL,
  phone text,
  machine_id text NOT NULL,
  valid_from date NOT NULL,
  valid_until date NOT NULL,
  devices int NOT NULL DEFAULT 1,
  amount_minor bigint NOT NULL DEFAULT 0,
  note text,
  key text NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES platform_admins(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX desktop_licenses_root ON desktop_licenses (root_id, valid_until DESC);
CREATE INDEX desktop_licenses_machine ON desktop_licenses (machine_id);

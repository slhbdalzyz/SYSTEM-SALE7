-- Restoring a backup. The file is uploaded in pieces into a staging area, checked as a whole,
-- then swapped in with one transaction, so a failed or half-uploaded restore changes nothing.
CREATE TABLE restore_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restore_jobs_tenant ON restore_jobs (tenant_id);

CREATE TABLE restore_rows (
  seq bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES restore_jobs(id) ON DELETE CASCADE,
  tbl text NOT NULL,
  row jsonb NOT NULL
);
CREATE INDEX restore_rows_job ON restore_rows (job_id, tbl);

-- Set when a shop's data is restored; tills that synced before it reload their whole catalog.
ALTER TABLE tenants ADD COLUMN restored_at timestamptz;

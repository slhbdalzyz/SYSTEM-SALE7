-- How a shift was closed: the note-by-note count, the card machine's total, the change left for
-- the next shift, the reason for a difference and who approved it, and who closed it (the
-- cashier, the owner from the dashboard, or the clock).
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS counted_notes jsonb,
  ADD COLUMN IF NOT EXISTS card_counted_minor bigint,
  ADD COLUMN IF NOT EXISTS card_expected_minor bigint,
  ADD COLUMN IF NOT EXISTS transfer_counted_minor bigint,
  ADD COLUMN IF NOT EXISTS transfer_expected_minor bigint,
  ADD COLUMN IF NOT EXISTS float_minor bigint,
  ADD COLUMN IF NOT EXISTS diff_reason text,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS closed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS close_kind text NOT NULL DEFAULT 'till' CHECK (close_kind IN ('till', 'owner', 'auto')),
  -- No foreign key: a backup restores shifts before pay entries.
  ADD COLUMN IF NOT EXISTS payroll_entry_id uuid;

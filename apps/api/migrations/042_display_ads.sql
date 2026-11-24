-- The customer screen's slides between sales (pictures, offers), kept apart from the settings so
-- the tills' regular sign-in doesn't carry the pictures every time.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS display_ads jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Desktop licence packages (small, medium, large): which package a key was sold as, the devices
-- bought on top of it, what one year of it costs (for working out a mid-year upgrade), and the
-- key it upgraded.
ALTER TABLE desktop_licenses ADD COLUMN IF NOT EXISTS plan text;
ALTER TABLE desktop_licenses ADD COLUMN IF NOT EXISTS extra_devices int NOT NULL DEFAULT 0;
ALTER TABLE desktop_licenses ADD COLUMN IF NOT EXISTS annual_minor bigint;
ALTER TABLE desktop_licenses ADD COLUMN IF NOT EXISTS upgrade_of uuid;

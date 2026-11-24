-- The till's catalogue reads each unit's barcodes by unit. Without this index every unit scanned the
-- whole barcodes table: a shop with 20,000 items waited 45 s for a new till to load, and every
-- other request (sales included) waited behind it on the desktop edition.
CREATE INDEX IF NOT EXISTS barcodes_unit ON barcodes (unit_id);

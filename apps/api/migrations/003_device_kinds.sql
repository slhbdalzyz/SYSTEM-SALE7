-- A device is a cashier till or a price checker on the shop floor (no one signs in on it).
ALTER TABLE devices ADD COLUMN kind text NOT NULL DEFAULT 'pos' CHECK (kind IN ('pos', 'price_checker'));

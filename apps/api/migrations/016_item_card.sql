-- The item card: whether an item has an expiry date (its supply lines then need one), and, on a
-- supply line, which unit the selling price was set for (a box bought, a piece priced).
ALTER TABLE products ADD COLUMN track_expiry boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_lines ADD COLUMN sell_unit_name text;

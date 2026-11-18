-- Services sold at the till with nothing taken from stock: flashing a phone's software, installing
-- programs, fitting a part, a haircut, delivery. A service can still use parts through a recipe.
ALTER TABLE products ADD COLUMN is_service boolean NOT NULL DEFAULT false;

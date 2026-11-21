-- Ways of paying a shop adds itself (a new wallet, another bank's card): the payment keeps the
-- money account it counts in (card or transfer) and carries the name the shop gave it.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS label text;

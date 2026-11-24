-- What each till last told the server: how many sales it still holds to send, and from which
-- address on the shop's network. The owner sees it in «الأجهزة».
ALTER TABLE devices ADD COLUMN IF NOT EXISTS pending_count integer;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS failed_count integer;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_ip text;

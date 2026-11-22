-- The AI helper on «من الدفتر للنظام»: how much each shop used it per day, so a daily cap holds,
-- and it starts closed on the basic plan (the platform opens it per plan or per shop).
CREATE TABLE IF NOT EXISTS ai_usage (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day date NOT NULL,
  requests int NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

UPDATE plans SET features = features || '{"ai_helper": false}'::jsonb WHERE code = 'basic' AND NOT (features ? 'ai_helper');

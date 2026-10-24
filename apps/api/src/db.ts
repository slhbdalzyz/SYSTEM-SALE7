import pg from "pg";

// bigint columns hold money (dirham) and milli-quantities, both far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// sum() over bigint returns numeric; the schema has no other numeric columns.
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url = process.env.DATABASE_URL ?? "postgres://pos:pos@localhost:5432/pos"): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const out = await fn(tx);
    await tx.query("COMMIT");
    return out;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}

export async function audit(
  q: Db | Tx,
  e: { tenantId: string; userId?: string | null; deviceId?: string | null; action: string; entity?: string; entityId?: string; data?: unknown },
) {
  await q.query(
    `INSERT INTO audit_log (tenant_id, user_id, device_id, action, entity, entity_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.tenantId, e.userId ?? null, e.deviceId ?? null, e.action, e.entity ?? null, e.entityId ?? null, e.data ?? null],
  );
}

import { DEFAULT_LOYALTY, loyaltySettingsSchema, type LoyaltySettings } from "@pos/shared";
import type { Db, Tx } from "./db";

export async function loyaltySettings(q: Db | Tx, tenantId: string): Promise<LoyaltySettings> {
  const raw = (await q.query(`SELECT loyalty FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.loyalty;
  const parsed = loyaltySettingsSchema.safeParse({ ...DEFAULT_LOYALTY, ...(raw ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_LOYALTY;
}

export async function customerPoints(q: Db | Tx, customerId: string): Promise<number> {
  return Number((await q.query(`SELECT COALESCE(sum(points), 0)::bigint AS p FROM loyalty_entries WHERE customer_id = $1`, [customerId])).rows[0].p);
}

export async function addPoints(
  q: Db | Tx,
  e: { tenantId: string; customerId: string; points: number; kind: "earn" | "redeem" | "return" | "adjust"; saleId?: string | null; note?: string | null; userId?: string | null },
) {
  if (!e.points) return;
  await q.query(
    `INSERT INTO loyalty_entries (tenant_id, customer_id, points, kind, sale_id, note, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.tenantId, e.customerId, e.points, e.kind, e.saleId ?? null, e.note ?? null, e.userId ?? null],
  );
}

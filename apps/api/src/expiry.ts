import { shelfBatches, type ShelfBatch } from "@pos/shared";
import type { Db, Tx } from "./db";
import { raiseAlert } from "./alerts";

type Q = Db | Tx;

export interface ShelfItem {
  productId: string;
  name: string;
  isWeighted: boolean;
  stockMilli: number;
  supplier: string | null;
  batches: ShelfBatch[];
}

/**
 * The dated stock on one branch's shelves, delivery by delivery: the expiry dates of the newest
 * deliveries that the stock still comes from (shops sell the oldest boxes first). Items with no
 * stock, or no dated deliveries, are left out.
 */
export async function shelfExpiry(q: Q, tenantId: string, storeId: string): Promise<ShelfItem[]> {
  const rows = (await q.query(
    `WITH stock AS (
       SELECT m.product_id, sum(m.qty_milli)::bigint AS q FROM stock_movements m WHERE m.tenant_id = $1 AND m.store_id = $2 GROUP BY 1 HAVING sum(m.qty_milli) > 0
     )
     SELECT l.product_id, p.name, p.is_weighted, st.q AS stock_milli, to_char(l.expiry_date, 'YYYY-MM-DD') AS expiry,
            (l.qty_milli * u.factor_milli / 1000)::bigint AS qty_milli, i.created_at AS received_at, s.name AS supplier
     FROM purchase_lines l JOIN purchase_invoices i ON i.id = l.invoice_id JOIN products p ON p.id = l.product_id
     JOIN product_units u ON u.id = l.unit_id JOIN stock st ON st.product_id = l.product_id LEFT JOIN suppliers s ON s.id = i.supplier_id
     WHERE l.tenant_id = $1 AND i.store_id = $2 AND l.expiry_date IS NOT NULL AND p.active`,
    [tenantId, storeId],
  )).rows;
  type Acc = ShelfItem & { deliveries: { expiry: string; qtyMilli: number; receivedAt: string; supplier: string | null }[] };
  const by = new Map<string, Acc>();
  for (const r of rows) {
    const it: Acc = by.get(r.product_id) ?? { productId: r.product_id, name: r.name, isWeighted: r.is_weighted, stockMilli: Number(r.stock_milli), supplier: null, batches: [], deliveries: [] };
    it.deliveries.push({ expiry: r.expiry, qtyMilli: Number(r.qty_milli), receivedAt: new Date(r.received_at).toISOString(), supplier: r.supplier });
    by.set(r.product_id, it);
  }
  return [...by.values()].map(({ deliveries, ...it }) => {
    const batches = shelfBatches(deliveries, it.stockMilli);
    const first = deliveries.find((d) => d.expiry === batches[0]?.expiry);
    return { ...it, batches, supplier: first?.supplier ?? null };
  }).filter((it) => it.batches.length);
}

/** Today in Libya, as YYYY-MM-DD. */
export const libyaToday = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(now);

/**
 * Once a day per shop: medicines (or any dated goods) on the shelf that expire within the shop's
 * warning window, or already have. Cheap enough to run on each sync, like the zakat reminder.
 */
export async function checkExpirySoon(q: Q, tenantId: string, now = new Date()) {
  const t = (await q.query(`SELECT alert_settings FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  const days = Number(t?.alert_settings?.expiryDays ?? 30);
  if (!days) return false;
  const today = libyaToday(now);
  const seen = await q.query(`SELECT 1 FROM alerts WHERE tenant_id = $1 AND kind = 'expiry_soon' AND data->>'date' = $2`, [tenantId, today]);
  if (seen.rowCount) return false;
  const stores = (await q.query(`SELECT id, name FROM stores WHERE tenant_id = $1`, [tenantId])).rows;
  const limit = Date.parse(`${today}T00:00:00Z`) + days * 864e5;
  let expired = 0;
  let soon = 0;
  const names: string[] = [];
  for (const st of stores) {
    for (const it of await shelfExpiry(q, tenantId, st.id)) {
      const b = it.batches[0];
      const at = Date.parse(`${b.expiry}T00:00:00Z`);
      if (at > limit) continue;
      if (b.expiry < today) expired++;
      else soon++;
      if (names.length < 3 && !names.includes(it.name)) names.push(it.name);
    }
  }
  if (!expired && !soon) return false;
  const parts = [expired && `${expired} منتهي`, soon && `${soon} يخلص خلال ${days} يوم`].filter(Boolean).join(" و");
  await raiseAlert(q, {
    tenantId, kind: "expiry_soon", title: `الصلاحية: ${parts}`,
    body: `${names.join("، ")}${expired + soon > names.length ? "…" : ""}. التفاصيل في تقرير «قرب انتهاء الصلاحية».`, data: { date: today, expired, soon },
  });
  return true;
}

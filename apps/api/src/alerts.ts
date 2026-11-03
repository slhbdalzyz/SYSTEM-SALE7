import { formatMoney, formatQty } from "@pos/shared";
import type { Db, Tx } from "./db";

export type AlertKind = "low_stock" | "out_of_stock" | "big_return" | "big_discount" | "cash_diff" | "over_credit_limit";

/** What a shop wants to hear about. Amounts in dirham; 0 turns that alert off. */
export interface AlertSettings {
  lowStock: boolean;
  returnOverMinor: number;
  discountOverMinor: number;
  cashDiffOverMinor: number;
  overCreditLimit: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = { lowStock: true, returnOverMinor: 50000, discountOverMinor: 20000, cashDiffOverMinor: 5000, overCreditLimit: true };

type Q = Db | Tx;

export async function alertSettings(q: Q, tenantId: string): Promise<AlertSettings> {
  const r = await q.query(`SELECT alert_settings FROM tenants WHERE id = $1`, [tenantId]);
  return { ...DEFAULT_ALERT_SETTINGS, ...(r.rows[0]?.alert_settings ?? {}) };
}

export async function raiseAlert(q: Q, a: { tenantId: string; storeId?: string | null; kind: AlertKind; title: string; body: string; data?: unknown }) {
  await q.query(`INSERT INTO alerts (tenant_id, store_id, kind, title, body, data) VALUES ($1,$2,$3,$4,$5,$6)`, [
    a.tenantId, a.storeId ?? null, a.kind, a.title, a.body, a.data ?? null,
  ]);
}

async function storeName(q: Q, storeId: string): Promise<string> {
  return (await q.query(`SELECT name FROM stores WHERE id = $1`, [storeId])).rows[0]?.name ?? "";
}

/**
 * After stock went out of a store: an alert for each product that just crossed its minimum
 * (or ran out), once, not on every later sale while it stays low.
 */
export async function checkLowStock(q: Q, tenantId: string, storeId: string, taken: Map<string, number>) {
  if (!taken.size || !(await alertSettings(q, tenantId)).lowStock) return;
  const r = await q.query(
    `SELECT p.id, p.name, p.is_weighted, p.min_stock_milli, COALESCE(sum(m.qty_milli), 0)::bigint AS stock_milli
     FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id AND m.store_id = $2
     WHERE p.tenant_id = $1 AND p.id = ANY($3::uuid[]) AND p.active AND p.min_stock_milli > 0
     GROUP BY p.id`,
    [tenantId, storeId, [...taken.keys()]],
  );
  if (!r.rowCount) return;
  const where = await storeName(q, storeId);
  for (const p of r.rows) {
    const after = Number(p.stock_milli);
    const before = after + (taken.get(p.id) ?? 0);
    const left = formatQty(Math.max(after, 0), p.is_weighted);
    if (after <= 0 && before > 0) {
      await raiseAlert(q, { tenantId, storeId, kind: "out_of_stock", title: `خلص: ${p.name}`, body: `${p.name} خلص من ${where}`, data: { productId: p.id } });
    } else if (after > 0 && after <= p.min_stock_milli && before > p.min_stock_milli) {
      await raiseAlert(q, {
        tenantId, storeId, kind: "low_stock", title: `قرب يخلص: ${p.name}`,
        body: `باقي ${left} في ${where} (الحد ${formatQty(p.min_stock_milli, p.is_weighted)})`, data: { productId: p.id },
      });
    }
  }
}

export async function alertBigReturn(q: Q, a: { tenantId: string; storeId: string; totalMinor: number; number: string; original: string; reason: string; cashier: string }) {
  const s = await alertSettings(q, a.tenantId);
  if (!s.returnOverMinor || a.totalMinor < s.returnOverMinor) return;
  await raiseAlert(q, {
    tenantId: a.tenantId, storeId: a.storeId, kind: "big_return", title: `مرتجع ${formatMoney(a.totalMinor)}`,
    body: `${a.cashier} رجّع من الفاتورة ${a.original}: ${a.reason}`, data: { number: a.number },
  });
}

export async function alertBigDiscount(q: Q, a: { tenantId: string; storeId: string; discountMinor: number; number: string; cashier: string }) {
  const s = await alertSettings(q, a.tenantId);
  if (!s.discountOverMinor || a.discountMinor < s.discountOverMinor) return;
  await raiseAlert(q, {
    tenantId: a.tenantId, storeId: a.storeId, kind: "big_discount", title: `خصم ${formatMoney(a.discountMinor)}`,
    body: `${a.cashier} عطى خصم على الفاتورة ${a.number}`, data: { number: a.number },
  });
}

export async function alertCashDiff(q: Q, a: { tenantId: string; storeId: string; diffMinor: number; cashier: string; device: string }) {
  const s = await alertSettings(q, a.tenantId);
  if (!s.cashDiffOverMinor || Math.abs(a.diffMinor) < s.cashDiffOverMinor) return;
  const what = a.diffMinor < 0 ? "ناقص" : "زايد";
  await raiseAlert(q, {
    tenantId: a.tenantId, storeId: a.storeId, kind: "cash_diff", title: `الدرج ${what} ${formatMoney(Math.abs(a.diffMinor))}`,
    body: `${a.cashier} قفل الوردية على ${a.device}`, data: { diff: a.diffMinor },
  });
}

export async function alertOverCreditLimit(q: Q, a: { tenantId: string; storeId: string; customer: string; balanceMinor: number; limitMinor: number }) {
  if (!(await alertSettings(q, a.tenantId)).overCreditLimit) return;
  await raiseAlert(q, {
    tenantId: a.tenantId, storeId: a.storeId, kind: "over_credit_limit", title: `${a.customer} فات حد الدين`,
    body: `عليه ${formatMoney(a.balanceMinor)} والحد ${formatMoney(a.limitMinor)}`,
  });
}

// ---- Phone notifications (Web Push) ----

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
/** Sends one notification. `gone` means the phone unsubscribed, so the row can go. */
export type Pusher = (to: PushTarget, payload: string) => Promise<{ gone?: boolean }>;

let pusher: Pusher | null = null;
let publicKey: string | null = null;

/** Set by the server when VAPID keys are configured; the demo and tests run without it. */
export function setPusher(p: Pusher | null, vapidPublicKey: string | null) {
  pusher = p;
  publicKey = p ? vapidPublicKey : null;
}

export const pushPublicKey = () => publicKey;

/** Sends a shop's new alerts to the phones of its owners and managers. Never throws. */
export async function flushPushes(db: Db, tenantId: string) {
  if (!pusher) return;
  try {
    const pending = (await db.query(
      `UPDATE alerts SET pushed_at = now() WHERE tenant_id = $1 AND pushed_at IS NULL AND created_at > now() - interval '1 hour'
       RETURNING id, kind, title, body`,
      [tenantId],
    )).rows;
    if (!pending.length) return;
    const subs = (await db.query(
      `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id
       WHERE ps.tenant_id = $1 AND u.active AND u.role IN ('owner', 'manager')`,
      [tenantId],
    )).rows;
    // Several alerts at once become one notification, so a busy sale does not buzz five times.
    const payload = JSON.stringify(
      pending.length === 1
        ? { title: pending[0].title, body: pending[0].body, tag: pending[0].kind }
        : { title: `${pending.length} تنبيهات جديدة`, body: pending.map((a) => a.title).join(" · "), tag: "many" },
    );
    await Promise.all(
      subs.map(async (s) => {
        try {
          const r = await pusher!(s, payload);
          if (r.gone) await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
        } catch {
          /* one phone failing must not stop the others */
        }
      }),
    );
  } catch {
    /* notifications are best effort; the alert is still in the list */
  }
}

import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, inTx, type Tx } from "../db";
import { HttpError, requireRole } from "../auth";
import { FLOWS } from "./money";

/**
 * «بداية جديدة»: the owner wipes the shop's data and starts again, keeping the account.
 *
 * Every table that holds a shop's data is in exactly one of three lists (a test checks it, so a
 * new table has to be placed on purpose):
 *  - KEEP: the account itself, never wiped here (shop, branches, staff, tills, subscription,
 *    audit log, support, bank accounts, restaurant tables);
 *  - MOVES: what happened (sales, purchases, payments, stock moves, expenses...), wiped by every level;
 *  - CATALOG: what the shop has (items, departments, customers, suppliers...), wiped only by «all».
 *
 * The levels:
 *  - moves: the history goes; stock, customer and supplier balances, points and the treasury
 *    carry over as one opening line each, so the shop stands exactly where it was;
 *  - stock: the same, but every quantity starts at zero;
 *  - all:   everything but the account goes, as on the first day.
 */

export const KEEP_TABLES = [
  "tenants", "stores", "users", "devices", "device_requests", "device_links", "push_subscriptions",
  "subscription_payments", "payment_intents", "coupon_redemptions", "subscription_reminders",
  "support_tickets", "platform_audit", "audit_log", "restore_jobs", "server_errors", "ai_usage",
  "bank_accounts", "dining_tables",
];

/** Children before parents: each delete runs after the rows that point at it are gone. */
export const MOVES_TABLES = [
  "loyalty_entries", "payments", "product_serials", "payroll_entries", "payroll_months", "sale_lines",
  "customer_payments", "drawer_moves", "installment_plans", "supplier_payments", "purchase_lines",
  "purchase_invoices", "stock_counts", "stock_transfer_lines", "stock_transfers", "stock_movements",
  "breakdowns", "kitchen_tickets", "repairs", "quotes", "expenses", "money_movements", "money_cleared",
  "bank_reconciliations", "alerts", "zakat_reports", "sales", "shifts",
];

export const CATALOG_TABLES = [
  "quick_keys", "quick_groups", "recipe_lines", "unit_prices", "barcodes", "product_units", "products",
  "categories", "offers", "kits", "customers", "suppliers",
];

export const RESET_MODES = ["moves", "stock", "all"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

/** The note on every line a reset carries over, so a later partial restore can find and replace them. */
export const CARRIED = "رصيد بعد التصفير";

/** Checks the owner's password again before anything that cannot be undone. */
export async function checkOwnerPassword(db: { query: Tx["query"] }, tid: string, uid: string, password: string) {
  const me = (await db.query(`SELECT password_hash FROM users WHERE id = $1 AND tenant_id = $2`, [uid, tid])).rows[0];
  if (!me?.password_hash || !(await bcrypt.compare(password, me.password_hash))) throw new HttpError(401, "كلمة السر غلط");
}

const confirmWord = z.string().transform((s) => s.trim()).refine((s) => s === "تصفير", { message: "اكتب كلمة «تصفير» للتأكيد" });

export async function resetRoutes(app: FastifyInstance) {
  const owners = { preHandler: requireRole("owner") };

  /** What each level would remove, for the screen before the owner decides. */
  app.get("/reset/preview", owners, async (req) => {
    const tid = req.user.tid;
    const n = async (sql: string) => Number((await app.db.query(sql, [tid])).rows[0].n);
    const [products, customers, suppliers, sales, purchases, openShifts] = await Promise.all([
      n(`SELECT count(*) AS n FROM products WHERE tenant_id = $1`),
      n(`SELECT count(*) AS n FROM customers WHERE tenant_id = $1`),
      n(`SELECT count(*) AS n FROM suppliers WHERE tenant_id = $1`),
      n(`SELECT count(*) AS n FROM sales WHERE tenant_id = $1`),
      n(`SELECT count(*) AS n FROM purchase_invoices WHERE tenant_id = $1`),
      n(`SELECT count(*) AS n FROM shifts WHERE tenant_id = $1 AND closed_at IS NULL`),
    ]);
    return { products, customers, suppliers, sales, purchases, openShifts };
  });

  app.post("/reset", { ...owners, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({ mode: z.enum(RESET_MODES), password: z.string().min(1).max(200), confirm: confirmWord }).parse(req.body);
    const tid = req.user.tid;
    await checkOwnerPassword(app.db, tid, req.user.sub, b.password);
    const open = (await app.db.query(`SELECT count(*)::int AS n FROM shifts WHERE tenant_id = $1 AND closed_at IS NULL`, [tid])).rows[0].n as number;
    // A till with an open shift would send sales for a shift that no longer exists.
    if (open) throw new HttpError(409, `فيه ${open} وردية مفتوحة. سكّر كل الورديات وخلّي أجهزة الكاشير تبعت مبيعاتها، وبعدها صفّر`);
    const out = await inTx(app.db, (tx) => resetShop(tx, tid, req.user.sub, b.mode));
    return { ok: true, ...out };
  });
}

/** Wipes one shop's data at the given level, in the caller's transaction. */
export async function resetShop(tx: Tx, tid: string, userId: string, mode: ResetMode) {
  await tx.query(`SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, [tid]);
  const keepState = mode !== "all";
  let stock: { store_id: string; product_id: string; qty: number }[] = [];
  let points: { customer_id: string; points: number }[] = [];
  let money: { account: string; bank_id: string | null; amount: number }[] = [];

  if (keepState) {
    // What everyone owes now becomes where they start.
    await tx.query(
      `UPDATE customers c SET opening_balance_minor = b.balance_minor, updated_at = now() FROM customer_balances b WHERE b.customer_id = c.id AND c.tenant_id = $1`,
      [tid],
    );
    await tx.query(`UPDATE suppliers s SET opening_balance_minor = b.balance_minor FROM supplier_balances b WHERE b.supplier_id = s.id AND s.tenant_id = $1`, [tid]);
    points = (await tx.query(
      `SELECT customer_id, sum(points)::bigint AS points FROM loyalty_entries WHERE tenant_id = $1 GROUP BY customer_id HAVING sum(points) <> 0`,
      [tid],
    )).rows.map((r) => ({ customer_id: r.customer_id, points: Number(r.points) }));
    money = (await tx.query(`WITH f AS (${FLOWS}) SELECT account, bank_id, sum(amount)::bigint AS amount FROM f GROUP BY account, bank_id HAVING sum(amount) <> 0`, [tid]))
      .rows.map((r) => ({ account: r.account, bank_id: r.bank_id, amount: Number(r.amount) }));
    if (mode === "moves") {
      stock = (await tx.query(
        `SELECT store_id, product_id, sum(qty_milli)::bigint AS qty FROM stock_movements WHERE tenant_id = $1 GROUP BY store_id, product_id HAVING sum(qty_milli) <> 0`,
        [tid],
      )).rows.map((r) => ({ store_id: r.store_id, product_id: r.product_id, qty: Number(r.qty) }));
    }
  }

  const removed: Record<string, number> = {};
  const wipe = async (table: string, where = "tenant_id = $1") => {
    const r = await tx.query(`DELETE FROM ${table} WHERE ${where}`, [tid]);
    if (r.rowCount) removed[table] = (removed[table] ?? 0) + r.rowCount;
  };
  for (const t of MOVES_TABLES) {
    // Pieces still on the shelf stay when the stock does; sold ones go with their sales.
    if (t === "product_serials" && mode === "moves") await wipe(t, `tenant_id = $1 AND (status = 'sold' OR sale_id IS NOT NULL)`);
    // A device still in the workshop is not history: it is someone's phone on the bench.
    else if (t === "repairs" && keepState) await wipe(t, `tenant_id = $1 AND status IN ('delivered', 'cancelled')`);
    else await wipe(t);
  }
  if (mode === "all") for (const t of CATALOG_TABLES) await wipe(t);

  for (const s of stock) {
    await tx.query(`INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, note, user_id) VALUES ($1,$2,$3,$4,'adjust',$5,$6)`, [tid, s.store_id, s.product_id, s.qty, CARRIED, userId]);
  }
  for (const p of points) {
    await tx.query(`INSERT INTO loyalty_entries (tenant_id, customer_id, points, kind, note, user_id) VALUES ($1,$2,$3,'adjust',$4,$5)`, [tid, p.customer_id, p.points, CARRIED, userId]);
  }
  for (const m of money) {
    await tx.query(
      `INSERT INTO money_movements (tenant_id, account, kind, amount_minor, note, on_date, created_by, bank_account_id) VALUES ($1,$2,'opening',$3,$4,(now() AT TIME ZONE 'Africa/Tripoli')::date,$5,$6)`,
      [tid, m.account, m.amount, CARRIED, userId, m.bank_id],
    );
  }
  // Tills that synced before now reload everything, as after a restore.
  await tx.query(`UPDATE tenants SET restored_at = now() WHERE id = $1`, [tid]);
  await audit(tx, { tenantId: tid, userId, action: "data.reset", data: { mode, removed, carried: { stock: stock.length, points: points.length, money: money.length } } });
  return { removed, carried: { stock: stock.length, points: points.length, money: money.length } };
}

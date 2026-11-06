import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { computeZakat, formatHijri, nextHawl, readZakatSettings, zakatSettingsSchema, type ZakatSettings } from "@pos/shared";
import type { Db, Tx } from "../db";
import { audit } from "../db";
import { HttpError, requireRole } from "../auth";
import { FLOWS } from "./money";

/**
 * Zakat on the shop, once a year: when the year turns, what the goods are worth (from the stock
 * the system holds, best right after a count), the money in the drawers and the bank, what
 * customers owe (the owner leaves out debts that will not come back), what the shop owes, and the
 * nisab from today's gold price. Each year's sheet is kept as it was signed off.
 */

type Q = Db | Tx;

export async function zakatSettings(q: Q, tid: string): Promise<ZakatSettings> {
  const r = await q.query(`SELECT zakat_settings FROM tenants WHERE id = $1`, [tid]);
  return readZakatSettings(r.rows[0]?.zakat_settings);
}

/** Every figure the sheet needs, as the books stand now. */
async function figures(q: Q, tid: string, valuation: ZakatSettings["valuation"], exclude: string[]) {
  const stores = (await q.query(
    `WITH s AS (SELECT m.store_id, m.product_id, sum(m.qty_milli) AS q FROM stock_movements m WHERE m.tenant_id = $1 GROUP BY 1, 2)
     SELECT st.id, st.name,
            COALESCE(sum(s.q * p.cost_minor / 1000) FILTER (WHERE s.q > 0), 0)::bigint AS cost_minor,
            COALESCE(sum(s.q * COALESCE((SELECT pu.price_minor FROM product_units pu WHERE pu.product_id = p.id ORDER BY pu.is_base DESC, pu.factor_milli LIMIT 1), 0) / 1000) FILTER (WHERE s.q > 0), 0)::bigint AS price_minor,
            count(*) FILTER (WHERE s.q > 0)::int AS items,
            (SELECT max(c.applied_at) FROM stock_counts c WHERE c.store_id = st.id AND c.status = 'applied') AS last_count_at,
            (SELECT c.id FROM stock_counts c WHERE c.store_id = st.id AND c.status = 'open' AND c.purpose = 'zakat' ORDER BY c.created_at DESC LIMIT 1) AS open_zakat_count
       FROM stores st LEFT JOIN s ON s.store_id = st.id LEFT JOIN products p ON p.id = s.product_id
      WHERE st.tenant_id = $1 GROUP BY st.id, st.name ORDER BY st.name`,
    [tid],
  )).rows.map((r) => ({
    id: r.id as string, name: r.name as string, costMinor: Number(r.cost_minor), priceMinor: Number(r.price_minor), items: r.items as number,
    lastCountAt: r.last_count_at as string | null, openZakatCount: r.open_zakat_count as string | null,
  }));
  const money = (await q.query(`WITH f AS (${FLOWS}) SELECT account, COALESCE(sum(amount), 0)::bigint AS balance FROM f GROUP BY account`, [tid])).rows;
  const acc = (a: string) => Math.max(0, Number(money.find((m) => m.account === a)?.balance ?? 0));
  const customers = (await q.query(
    `SELECT c.id, c.name, c.phone, b.balance_minor,
            GREATEST((SELECT max(cp.created_at) FROM customer_payments cp WHERE cp.customer_id = c.id),
                     (SELECT max(s.created_at) FROM sales s WHERE s.customer_id = c.id)) AS last_activity
       FROM customers c JOIN customer_balances b ON b.customer_id = c.id
      WHERE c.tenant_id = $1 AND b.balance_minor > 0 ORDER BY b.balance_minor DESC`,
    [tid],
  )).rows.map((c) => ({ id: c.id as string, name: c.name as string, phone: c.phone as string | null, balanceMinor: Number(c.balance_minor), lastActivity: c.last_activity as string | null }));
  const suppliers = (await q.query(
    `SELECT s.id, s.name, b.balance_minor FROM suppliers s JOIN supplier_balances b ON b.supplier_id = s.id
      WHERE s.tenant_id = $1 AND b.balance_minor > 0 ORDER BY b.balance_minor DESC`,
    [tid],
  )).rows.map((s) => ({ id: s.id as string, name: s.name as string, balanceMinor: Number(s.balance_minor) }));
  const skip = new Set(exclude);
  return {
    stores,
    inventoryMinor: stores.reduce((a, s) => a + (valuation === "cost" ? s.costMinor : s.priceMinor), 0),
    accounts: { cash: acc("cash"), card: acc("card"), transfer: acc("transfer") },
    cashMinor: acc("cash") + acc("card") + acc("transfer"),
    customers,
    receivablesMinor: customers.filter((c) => !skip.has(c.id)).reduce((a, c) => a + c.balanceMinor, 0),
    excludedMinor: customers.filter((c) => skip.has(c.id)).reduce((a, c) => a + c.balanceMinor, 0),
    suppliers,
    payablesMinor: suppliers.reduce((a, s) => a + s.balanceMinor, 0),
  };
}

const hawlOf = (s: ZakatSettings, now = new Date()) => {
  const h = nextHawl(s, now);
  return { date: h.date.toISOString().slice(0, 10), daysLeft: h.daysLeft, year: h.year, label: s.calendar === "hijri" ? formatHijri(h.date) : h.date.toISOString().slice(0, 10) };
};

export async function zakatRoutes(app: FastifyInstance) {
  const owner = { preHandler: requireRole("owner") };

  app.get("/zakat/settings", owner, async (req) => {
    const s = await zakatSettings(app.db, req.user.tid);
    return { settings: s, hawl: hawlOf(s) };
  });

  app.put("/zakat/settings", owner, async (req) => {
    const s = zakatSettingsSchema.parse(req.body);
    await app.db.query(`UPDATE tenants SET zakat_settings = $2 WHERE id = $1`, [req.user.tid, JSON.stringify(s)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "zakat.settings", entity: "tenant", entityId: req.user.tid, data: s });
    return { settings: s, hawl: hawlOf(s) };
  });

  /** The sheet as it would come out today, for the owner to check before signing it off. */
  app.get("/zakat/preview", owner, async (req) => {
    const q = z.object({ valuation: z.enum(["cost", "price"]).optional() }).parse(req.query);
    const s = await zakatSettings(app.db, req.user.tid);
    const f = await figures(app.db, req.user.tid, q.valuation ?? s.valuation, []);
    return { settings: s, hawl: hawlOf(s), ...f };
  });

  const reportBody = z.object({
    valuation: z.enum(["cost", "price"]),
    goldGramMinor: z.number().int().min(1, "اكتب سعر جرام الذهب اليوم"),
    otherAssetsMinor: z.number().int().min(0).default(0),
    otherDebtsMinor: z.number().int().min(0).default(0),
    excludeCustomers: z.array(z.string().uuid()).max(5000).default([]),
    note: z.string().trim().max(500).optional(),
  });

  /** Signs off this year's sheet: the figures are worked out again here and kept as they are. */
  app.post("/zakat/reports", owner, async (req) => {
    const b = reportBody.parse(req.body);
    const tid = req.user.tid;
    const s = await zakatSettings(app.db, tid);
    const f = await figures(app.db, tid, b.valuation, b.excludeCustomers);
    const r = computeZakat({
      inventoryMinor: f.inventoryMinor, cashMinor: f.cashMinor, receivablesMinor: f.receivablesMinor, otherAssetsMinor: b.otherAssetsMinor,
      payablesMinor: f.payablesMinor, otherDebtsMinor: b.otherDebtsMinor, goldGramMinor: b.goldGramMinor, nisabGrams: s.nisabGrams, calendar: s.calendar,
    });
    const now = new Date();
    const yearLabel = s.calendar === "hijri" ? `${nextHawl(s, now).year}هـ` : String(now.getFullYear());
    const skip = new Set(b.excludeCustomers);
    const details = {
      hijri: formatHijri(now),
      stores: f.stores.map((x) => ({ name: x.name, costMinor: x.costMinor, priceMinor: x.priceMinor, items: x.items, lastCountAt: x.lastCountAt })),
      accounts: f.accounts,
      excluded: f.customers.filter((c) => skip.has(c.id)).map((c) => ({ name: c.name, balanceMinor: c.balanceMinor })),
      excludedMinor: f.excludedMinor,
      customers: f.customers.length - skip.size,
      suppliers: f.suppliers.length,
      nisabMinor: r.nisabMinor,
      reachesNisab: r.reachesNisab,
    };
    const row = (await app.db.query(
      `INSERT INTO zakat_reports (tenant_id, year_label, on_date, calendar, valuation, inventory_minor, cash_minor, receivables_minor, other_assets_minor,
                                  payables_minor, other_debts_minor, gold_gram_minor, nisab_grams, base_minor, rate, zakat_minor, details, note, created_by)
       VALUES ($1,$2,(now() AT TIME ZONE 'Africa/Tripoli')::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [tid, yearLabel, s.calendar, b.valuation, f.inventoryMinor, f.cashMinor, f.receivablesMinor, b.otherAssetsMinor, f.payablesMinor, b.otherDebtsMinor,
        b.goldGramMinor, s.nisabGrams, r.baseMinor, r.rate, r.zakatMinor, JSON.stringify(details), b.note || null, req.user.sub],
    )).rows[0];
    // Next year the gold price box starts from this one.
    await app.db.query(`UPDATE tenants SET zakat_settings = $2 WHERE id = $1`, [tid, JSON.stringify({ ...s, goldGramMinor: b.goldGramMinor, valuation: b.valuation })]);
    await audit(app.db, { tenantId: tid, userId: req.user.sub, action: "zakat.report", entity: "zakat_report", entityId: row.id, data: { zakatMinor: r.zakatMinor, baseMinor: r.baseMinor } });
    return { id: row.id as string, ...r };
  });

  const toReport = (r: Record<string, unknown>) => ({
    id: r.id, yearLabel: r.year_label, onDate: r.on_date instanceof Date ? r.on_date.toISOString().slice(0, 10) : String(r.on_date).slice(0, 10),
    calendar: r.calendar, valuation: r.valuation, inventoryMinor: Number(r.inventory_minor), cashMinor: Number(r.cash_minor),
    receivablesMinor: Number(r.receivables_minor), otherAssetsMinor: Number(r.other_assets_minor), payablesMinor: Number(r.payables_minor),
    otherDebtsMinor: Number(r.other_debts_minor), goldGramMinor: Number(r.gold_gram_minor), nisabGrams: r.nisab_grams, baseMinor: Number(r.base_minor),
    rate: r.rate, zakatMinor: Number(r.zakat_minor), details: r.details, note: r.note, createdByName: r.created_by_name ?? null, createdAt: r.created_at,
  });

  app.get("/zakat/reports", owner, async (req) => {
    const rows = (await app.db.query(
      `SELECT z.*, u.name AS created_by_name FROM zakat_reports z LEFT JOIN users u ON u.id = z.created_by WHERE z.tenant_id = $1 ORDER BY z.on_date DESC, z.created_at DESC LIMIT 50`,
      [req.user.tid],
    )).rows;
    return rows.map(toReport);
  });

  app.get("/zakat/reports/:id", owner, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = (await app.db.query(
      `SELECT z.*, u.name AS created_by_name FROM zakat_reports z LEFT JOIN users u ON u.id = z.created_by WHERE z.id = $1 AND z.tenant_id = $2`,
      [id, req.user.tid],
    )).rows[0];
    if (!r) throw new HttpError(404, "التقرير غير موجود");
    return toReport(r);
  });

  /** A sheet signed off by mistake can go, and the deletion stays in the audit log. */
  app.post("/zakat/reports/:id/delete", owner, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await app.db.query(`DELETE FROM zakat_reports WHERE id = $1 AND tenant_id = $2 RETURNING year_label, zakat_minor`, [id, req.user.tid]);
    if (!r.rowCount) throw new HttpError(404, "التقرير غير موجود");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "zakat.delete", entity: "zakat_report", entityId: id, data: { year: r.rows[0].year_label, zakatMinor: Number(r.rows[0].zakat_minor) } });
    return { ok: true };
  });
}

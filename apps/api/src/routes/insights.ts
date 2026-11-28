// The deeper reports: customers, debts by age, expenses month by month, what each item really
// earns, suppliers and their prices, discounts / returns / voided carts per person, the month's
// forecast with the items about to run out, and the summary the owner gets on the phone.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { formatMoney, readShopSettings, reportDigestSchema, reportFavsSchema } from "@pos/shared";
import { HttpError, requireDevice, requirePerm } from "../auth";
import { flushPushes, raiseAlert } from "../alerts";
import type { Db, Tx } from "../db";

type Q = Db | Tx;
const TZ = "Africa/Tripoli";
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = z.object({ storeId: z.string().uuid().optional(), from: dateStr, to: dateStr });
const N = (v: unknown) => Number(v ?? 0);
const DAY = 864e5;

/** Today in Libya, as YYYY-MM-DD. */
export function libyaDay(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}
const addDays = (s: string, n: number) => new Date(Date.parse(`${s}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

function checkPeriod(from: string, to: string) {
  if (from > to) throw new HttpError(400, "بداية الفترة بعد نهايتها");
  if (daysBetween(from, to) > 731) throw new HttpError(400, "الفترة أطول من سنتين");
}

/** Sales, profit and expenses for a stretch of days: the numbers the summary and the full report open with. */
export async function periodTotals(q: Q, tid: string, from: string, to: string, storeId: string | null = null) {
  const r = (await q.query(
    `SELECT count(*) FILTER (WHERE s.kind = 'sale')::int AS n, COALESCE(sum(s.total_minor), 0)::bigint AS total,
            COALESCE((SELECT sum(l.total_minor - l.cost_minor) FROM sale_lines l JOIN sales x ON x.id = l.sale_id
                       WHERE x.tenant_id = $1 AND ($4::uuid IS NULL OR x.store_id = $4) AND (x.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date), 0)::bigint AS profit,
            COALESCE((SELECT sum(e.amount_minor) FROM expenses e WHERE e.tenant_id = $1 AND ($4::uuid IS NULL OR e.store_id = $4) AND e.spent_on BETWEEN $2::date AND $3::date), 0)::bigint AS expenses
       FROM sales s WHERE s.tenant_id = $1 AND ($4::uuid IS NULL OR s.store_id = $4) AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date`,
    [tid, from, to, storeId],
  )).rows[0];
  const total = N(r.total), profit = N(r.profit), expenses = N(r.expenses);
  return { salesCount: r.n as number, totalMinor: total, profitMinor: profit, expensesMinor: expenses, netMinor: profit - expenses, avgMinor: r.n ? Math.round(total / r.n) : 0 };
}

const change = (now: number, then: number) => (then ? Math.round(((now - then) / Math.abs(then)) * 100) : null);
const arrow = (p: number | null) => (p === null ? "" : ` (${p >= 0 ? "▲" : "▼"} ${Math.abs(p)}%)`);

/**
 * The summary the owner asked for (daily, weekly, monthly), once each, after the hour they chose:
 * an alert that reaches the phone, with the numbers against the stretch before.
 */
export async function checkDigest(q: Q, tid: string, now = new Date()) {
  const t = (await q.query(`SELECT settings FROM tenants WHERE id = $1`, [tid])).rows[0];
  const d = readShopSettings(t?.settings).reportDigest;
  if (!d.daily && !d.weekly && !d.monthly) return 0;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(now));
  if (hour < d.hour) return 0;
  const day = libyaDay(now);
  const due: { key: string; title: string; from: string; to: string; pFrom: string; pTo: string; than: string }[] = [];
  if (d.daily) due.push({ key: `daily:${day}`, title: `ملخص اليوم ${day.slice(8)}/${day.slice(5, 7)}`, from: day, to: day, pFrom: addDays(day, -7), pTo: addDays(day, -7), than: "نفس اليوم الأسبوع اللي فات" });
  // The week ends on Friday: Saturday morning brings the seven days before.
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (d.weekly && dow === 6) due.push({ key: `weekly:${day}`, title: "ملخص الأسبوع", from: addDays(day, -7), to: addDays(day, -1), pFrom: addDays(day, -14), pTo: addDays(day, -8), than: "الأسبوع اللي قبله" });
  if (d.monthly && day.endsWith("-01")) {
    const end = addDays(day, -1);
    const start = `${end.slice(0, 7)}-01`;
    const pEnd = addDays(start, -1);
    due.push({ key: `monthly:${end.slice(0, 7)}`, title: `ملخص شهر ${end.slice(5, 7)}/${end.slice(0, 4)}`, from: start, to: end, pFrom: `${pEnd.slice(0, 7)}-01`, pTo: pEnd, than: "الشهر اللي قبله" });
  }
  let n = 0;
  for (const x of due) {
    const seen = await q.query(`SELECT 1 FROM alerts WHERE tenant_id = $1 AND kind = 'report_digest' AND data->>'key' = $2`, [tid, x.key]);
    if (seen.rowCount) continue;
    const a = await periodTotals(q, tid, x.from, x.to);
    const b = await periodTotals(q, tid, x.pFrom, x.pTo);
    const body = [
      `المبيعات ${formatMoney(a.totalMinor)}${arrow(change(a.totalMinor, b.totalMinor))}`,
      `الفواتير ${a.salesCount}، متوسط الفاتورة ${formatMoney(a.avgMinor)}`,
      `الربح ${formatMoney(a.profitMinor)}${arrow(change(a.profitMinor, b.profitMinor))}`,
      ...(a.expensesMinor ? [`المصروفات ${formatMoney(a.expensesMinor)}، الصافي ${formatMoney(a.netMinor)}`] : []),
      `المقارنة مع ${x.than}.`,
    ].join("\n");
    await raiseAlert(q, { tenantId: tid, kind: "report_digest", title: x.title, body, data: { key: x.key, from: x.from, to: x.to } });
    n++;
  }
  return n;
}

export async function insightRoutes(app: FastifyInstance) {
  const managers = { preHandler: requirePerm("reports") };
  async function ownStore(tid: string, storeId: string | undefined) {
    if (!storeId) return;
    if (!(await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [storeId, tid])).rowCount) throw new HttpError(404, "الفرع غير موجود");
  }

  /** The owner's summary on the phone: which ones and from what hour. */
  app.patch("/settings/report-digest", { preHandler: requirePerm("reports") }, async (req) => {
    const b = reportDigestSchema.parse(req.body);
    const t = (await app.db.query(`SELECT settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    const s = readShopSettings(t?.settings);
    s.reportDigest = b;
    await app.db.query(`UPDATE tenants SET settings = $2 WHERE id = $1`, [req.user.tid, JSON.stringify(s)]);
    return { reportDigest: s.reportDigest };
  });

  /** Saved reports, and the ones pinned on the home page. */
  app.put("/settings/report-favs", { preHandler: requirePerm("reports") }, async (req) => {
    const b = reportFavsSchema.parse(req.body);
    const t = (await app.db.query(`SELECT settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    const s = readShopSettings(t?.settings);
    s.reportFavs = b;
    await app.db.query(`UPDATE tenants SET settings = $2 WHERE id = $1`, [req.user.tid, JSON.stringify(s)]);
    return { reportFavs: s.reportFavs };
  });

  /** Headline numbers for a stretch of days (the home page's pinned reports use it). */
  app.get("/reports/totals", managers, async (req) => {
    const q = period.parse(req.query);
    checkPeriod(q.from, q.to);
    await ownStore(req.user.tid, q.storeId);
    return periodTotals(app.db, req.user.tid, q.from, q.to, q.storeId ?? null);
  });

  /**
   * Customers in a stretch of days: the best ones, who is new and who came back, sales with no
   * customer named, and regulars who stopped coming.
   */
  app.get("/reports/customers", managers, async (req) => {
    const q = period.extend({ lapsedDays: z.coerce.number().int().min(7).max(365).default(30) }).parse(req.query);
    checkPeriod(q.from, q.to);
    await ownStore(req.user.tid, q.storeId);
    const args = [req.user.tid, q.storeId ?? null, q.from, q.to];
    const inP = `s.tenant_id = $1 AND ($2::uuid IS NULL OR s.store_id = $2) AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date`;
    const [rows, walkIn, lapsed] = await Promise.all([
      app.db.query(
        `SELECT c.id, c.name, c.phone, count(*) FILTER (WHERE s.kind = 'sale')::int AS visits, sum(s.total_minor)::bigint AS total,
                COALESCE(sum((SELECT sum(l.total_minor - l.cost_minor) FROM sale_lines l WHERE l.sale_id = s.id)), 0)::bigint AS profit,
                to_char(max(s.created_at) AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS last_day,
                (SELECT to_char(min(x.created_at) AT TIME ZONE '${TZ}', 'YYYY-MM-DD') FROM sales x WHERE x.customer_id = c.id AND x.kind = 'sale') AS first_day,
                COALESCE((SELECT b.balance_minor FROM customer_balances b WHERE b.customer_id = c.id), 0)::bigint AS balance
           FROM sales s JOIN customers c ON c.id = s.customer_id WHERE ${inP}
          GROUP BY c.id, c.name, c.phone ORDER BY 5 DESC LIMIT 300`, args),
      app.db.query(`SELECT count(*) FILTER (WHERE s.kind = 'sale')::int AS n, COALESCE(sum(s.total_minor), 0)::bigint AS total FROM sales s WHERE ${inP} AND s.customer_id IS NULL`, args),
      app.db.query(
        `SELECT c.id, c.name, c.phone, count(*)::int AS visits, sum(s.total_minor)::bigint AS total,
                to_char(max(s.created_at) AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS last_day
           FROM sales s JOIN customers c ON c.id = s.customer_id
          WHERE s.tenant_id = $1 AND ($2::uuid IS NULL OR s.store_id = $2) AND s.kind = 'sale'
          GROUP BY c.id, c.name, c.phone
         HAVING count(*) >= 2 AND (max(s.created_at) AT TIME ZONE '${TZ}')::date < $3::date - $4::int
          ORDER BY 5 DESC LIMIT 100`, [req.user.tid, q.storeId ?? null, q.to, q.lapsedDays]),
    ]);
    const list = rows.rows.map((r) => ({
      id: r.id as string, name: r.name as string, phone: r.phone as string | null, visits: r.visits as number, totalMinor: N(r.total), profitMinor: N(r.profit),
      avgMinor: r.visits ? Math.round(N(r.total) / r.visits) : 0, lastDay: r.last_day as string, firstDay: r.first_day as string | null, balanceMinor: N(r.balance),
      isNew: !!r.first_day && r.first_day >= q.from,
    }));
    const named = list.reduce((a, c) => a + c.totalMinor, 0);
    const span = Math.max(1, daysBetween(q.from, q.to) + 1);
    return {
      from: q.from, to: q.to,
      summary: {
        customers: list.length, newCustomers: list.filter((c) => c.isNew).length, returning: list.filter((c) => !c.isNew).length,
        namedMinor: named, walkInMinor: N(walkIn.rows[0].total), walkInCount: walkIn.rows[0].n as number,
        visitsPerCustomer: list.length ? Math.round((list.reduce((a, c) => a + c.visits, 0) / list.length) * 10) / 10 : 0,
        /** Days between visits for a customer who came more than once in the stretch. */
        daysBetweenVisits: (() => {
          const many = list.filter((c) => c.visits > 1);
          return many.length ? Math.round((many.reduce((a, c) => a + span / c.visits, 0) / many.length) * 10) / 10 : null;
        })(),
      },
      top: list,
      lapsed: lapsed.rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, visits: r.visits, totalMinor: N(r.total), lastDay: r.last_day, daysAway: daysBetween(r.last_day, q.to) })),
    };
  });

  /**
   * What customers owe, by how old it is. Payments clear the oldest credit first, so what is left
   * is the newest credit sales; a balance from before the system counts from the day it was set.
   */
  app.get("/reports/debts", managers, async (req) => {
    const q = z.object({ from: dateStr.optional(), to: dateStr.optional() }).parse(req.query);
    const tid = req.user.tid;
    const today = libyaDay();
    const owing = (await app.db.query(
      `SELECT c.id, c.name, c.phone, c.credit_limit_minor, c.opening_balance_minor, to_char(c.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS created_day, b.balance_minor,
              (SELECT to_char(max(cp.created_at) AT TIME ZONE '${TZ}', 'YYYY-MM-DD') FROM customer_payments cp WHERE cp.customer_id = c.id) AS last_paid
         FROM customers c JOIN customer_balances b ON b.customer_id = c.id WHERE c.tenant_id = $1 AND b.balance_minor > 0 ORDER BY b.balance_minor DESC LIMIT 1000`,
      [tid],
    )).rows;
    const credits = owing.length ? (await app.db.query(
      `SELECT s.customer_id, to_char(s.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day, sum(p.amount_minor)::bigint AS amount
         FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.tenant_id = $1 AND p.method = 'credit' AND s.customer_id = ANY($2::uuid[])
        GROUP BY s.customer_id, s.created_at ORDER BY s.created_at DESC`,
      [tid, owing.map((r) => r.id)],
    )).rows : [];
    const byCustomer = new Map<string, { day: string; amount: number }[]>();
    for (const c of credits) {
      const l = byCustomer.get(c.customer_id) ?? [];
      l.push({ day: c.day, amount: N(c.amount) });
      byCustomer.set(c.customer_id, l);
    }
    const BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
    const bucketOf = (days: number) => (days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3);
    const totals = [0, 0, 0, 0];
    const rows = owing.map((c) => {
      let left = N(c.balance_minor);
      const parts = [0, 0, 0, 0];
      let oldest: string | null = null;
      for (const s of byCustomer.get(c.id) ?? []) {
        if (left <= 0) break;
        const take = Math.min(left, s.amount);
        parts[bucketOf(daysBetween(s.day, today))] += take;
        left -= take;
        oldest = s.day;
      }
      if (left > 0) {
        parts[bucketOf(daysBetween(c.created_day, today))] += left;
        oldest = c.created_day;
      }
      parts.forEach((v, i) => (totals[i] += v));
      return {
        id: c.id, name: c.name, phone: c.phone, balanceMinor: N(c.balance_minor), limitMinor: c.credit_limit_minor === null ? null : N(c.credit_limit_minor),
        buckets: parts, oldestDay: oldest, oldestDays: oldest ? daysBetween(oldest, today) : 0, lastPaid: c.last_paid,
      };
    });
    let collected = null as null | { amountMinor: number; count: number; givenMinor: number };
    if (q.from && q.to) {
      const r = (await app.db.query(
        `SELECT COALESCE((SELECT sum(cp.amount_minor) FROM customer_payments cp WHERE cp.tenant_id = $1 AND (cp.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date), 0)::bigint AS got,
                (SELECT count(*) FROM customer_payments cp WHERE cp.tenant_id = $1 AND (cp.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date)::int AS n,
                COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.tenant_id = $1 AND p.method = 'credit' AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date), 0)::bigint AS given`,
        [tid, q.from, q.to],
      )).rows[0];
      collected = { amountMinor: N(r.got), count: r.n, givenMinor: N(r.given) };
    }
    return { buckets: BUCKETS, totals, totalMinor: totals.reduce((a, b) => a + b, 0), customers: rows.length, rows, collected };
  });

  /**
   * Expenses month by month for each heading, what share of sales they took, and a heading that
   * jumped this month against its last three months.
   */
  app.get("/reports/expenses", managers, async (req) => {
    const q = z.object({ storeId: z.string().uuid().optional(), months: z.coerce.number().int().min(2).max(24).default(12), to: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
    await ownStore(req.user.tid, q.storeId);
    const last = q.to ?? libyaDay().slice(0, 7);
    const months: string[] = [];
    for (let i = q.months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)) - 1 - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    const from = `${months[0]}-01`;
    const endMonth = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const args = [req.user.tid, q.storeId ?? null, from, endMonth];
    const [ex, sales] = await Promise.all([
      app.db.query(
        `SELECT to_char(e.spent_on, 'YYYY-MM') AS m, e.category, sum(e.amount_minor)::bigint AS amount, count(*)::int AS n FROM expenses e
          WHERE e.tenant_id = $1 AND ($2::uuid IS NULL OR e.store_id = $2) AND e.spent_on BETWEEN $3::date AND $4::date GROUP BY 1, 2`, args),
      app.db.query(
        `SELECT to_char(s.created_at AT TIME ZONE '${TZ}', 'YYYY-MM') AS m, COALESCE(sum(s.total_minor), 0)::bigint AS total,
                COALESCE(sum((SELECT sum(l.total_minor - l.cost_minor) FROM sale_lines l WHERE l.sale_id = s.id)), 0)::bigint AS profit
           FROM sales s WHERE s.tenant_id = $1 AND ($2::uuid IS NULL OR s.store_id = $2) AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date GROUP BY 1`, args),
    ]);
    const cats = new Map<string, number[]>();
    const counts = new Map<string, number>();
    for (const r of ex.rows) {
      const i = months.indexOf(r.m);
      if (i < 0) continue;
      const row = cats.get(r.category) ?? months.map(() => 0);
      row[i] += N(r.amount);
      cats.set(r.category, row);
      counts.set(r.category, (counts.get(r.category) ?? 0) + r.n);
    }
    const salesBy = months.map((m) => N(sales.rows.find((r) => r.m === m)?.total));
    const profitBy = months.map((m) => N(sales.rows.find((r) => r.m === m)?.profit));
    const totalBy = months.map((_, i) => [...cats.values()].reduce((a, r) => a + r[i], 0));
    const k = months.length - 1;
    const jumps = [...cats].flatMap(([name, r]) => {
      const before = r.slice(Math.max(0, k - 3), k).filter((v) => v > 0);
      if (!before.length || r[k] <= 0) return [];
      const avg = before.reduce((a, v) => a + v, 0) / before.length;
      return r[k] > avg * 1.3 && r[k] - avg >= 10_000 ? [{ category: name, nowMinor: r[k], avgMinor: Math.round(avg), pct: Math.round(((r[k] - avg) / avg) * 100) }] : [];
    });
    return {
      months,
      categories: [...cats].map(([name, byMonth]) => ({ name, byMonth, totalMinor: byMonth.reduce((a, v) => a + v, 0), count: counts.get(name) ?? 0 })).sort((a, b) => b.totalMinor - a.totalMinor),
      totalByMonth: totalBy, salesByMonth: salesBy, profitByMonth: profitBy,
      jumps,
    };
  });

  /**
   * What each item really earns over a stretch of days, plus items whose price today is under
   * their cost. The page sorts them into losers, busy-but-thin and the best earners.
   */
  app.get("/reports/margins", managers, async (req) => {
    const q = period.parse(req.query);
    checkPeriod(q.from, q.to);
    await ownStore(req.user.tid, q.storeId);
    const [rows, under] = await Promise.all([
      app.db.query(
        `SELECT l.product_id AS id, max(l.name) AS name, bool_or(p.is_weighted) AS weighted, c.name AS category,
                sum(l.qty_milli)::bigint AS qty, sum(l.total_minor)::bigint AS total, sum(l.cost_minor)::bigint AS cost, count(DISTINCT s.id)::int AS sales
           FROM sale_lines l JOIN sales s ON s.id = l.sale_id LEFT JOIN products p ON p.id = l.product_id LEFT JOIN categories c ON c.id = p.category_id
          WHERE s.tenant_id = $1 AND ($2::uuid IS NULL OR s.store_id = $2) AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date
          GROUP BY l.product_id, c.name HAVING sum(l.total_minor) <> 0 ORDER BY 6 DESC LIMIT 1000`,
        [req.user.tid, q.storeId ?? null, q.from, q.to],
      ),
      app.db.query(
        `SELECT p.id, p.name, p.cost_minor, u.price_minor, u.name AS unit FROM products p JOIN product_units u ON u.product_id = p.id AND u.is_base
          WHERE p.tenant_id = $1 AND p.active AND p.cost_minor > 0 AND u.price_minor < p.cost_minor ORDER BY (p.cost_minor - u.price_minor) DESC LIMIT 100`,
        [req.user.tid],
      ),
    ]);
    const items = rows.rows.map((r) => {
      const total = N(r.total), cost = N(r.cost), profit = total - cost;
      return { id: r.id, name: r.name, weighted: !!r.weighted, category: r.category ?? "بدون قسم", qtyMilli: N(r.qty), totalMinor: total, costMinor: cost, profitMinor: profit, sales: r.sales, marginPct: total ? Math.round((profit / total) * 1000) / 10 : 0 };
    });
    const total = items.reduce((a, i) => a + i.totalMinor, 0);
    const profit = items.reduce((a, i) => a + i.profitMinor, 0);
    return {
      from: q.from, to: q.to, totalMinor: total, profitMinor: profit, marginPct: total ? Math.round((profit / total) * 1000) / 10 : 0,
      items,
      underCost: under.rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, costMinor: N(r.cost_minor), priceMinor: N(r.price_minor) })),
    };
  });

  /** What the shop owes each supplier, and how each item's buying price moved in the stretch. */
  app.get("/reports/suppliers", managers, async (req) => {
    const q = period.parse(req.query);
    checkPeriod(q.from, q.to);
    await ownStore(req.user.tid, q.storeId);
    const [owed, prices] = await Promise.all([
      app.db.query(
        `SELECT s.id, s.name, s.phone, b.balance_minor,
                (SELECT to_char(max(i.invoice_date), 'YYYY-MM-DD') FROM purchase_invoices i WHERE i.supplier_id = s.id) AS last_invoice,
                (SELECT to_char(max(p.created_at) AT TIME ZONE '${TZ}', 'YYYY-MM-DD') FROM supplier_payments p WHERE p.supplier_id = s.id) AS last_paid,
                COALESCE((SELECT sum(i.total_minor) FROM purchase_invoices i WHERE i.supplier_id = s.id AND i.invoice_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR i.store_id = $4)), 0)::bigint AS bought
           FROM suppliers s JOIN supplier_balances b ON b.supplier_id = s.id WHERE s.tenant_id = $1 ORDER BY b.balance_minor DESC`,
        [req.user.tid, q.from, q.to, q.storeId ?? null],
      ),
      // Each item bought in the stretch: its first and last price there, and the price before it.
      app.db.query(
        `WITH b AS (
           SELECT l.product_id, l.name, l.unit_name, l.unit_cost_minor, i.invoice_date, i.created_at, s.name AS supplier,
                  (i.invoice_date BETWEEN $2::date AND $3::date) AS inside
             FROM purchase_lines l JOIN purchase_invoices i ON i.id = l.invoice_id LEFT JOIN suppliers s ON s.id = i.supplier_id
            WHERE i.tenant_id = $1 AND ($4::uuid IS NULL OR i.store_id = $4) AND i.invoice_date <= $3::date
         )
         SELECT product_id, max(name) AS name, max(unit_name) AS unit,
                (array_agg(unit_cost_minor ORDER BY invoice_date DESC, created_at DESC) FILTER (WHERE NOT inside))[1] AS before,
                (array_agg(unit_cost_minor ORDER BY invoice_date, created_at) FILTER (WHERE inside))[1] AS first,
                (array_agg(unit_cost_minor ORDER BY invoice_date DESC, created_at DESC) FILTER (WHERE inside))[1] AS last,
                (array_agg(supplier ORDER BY invoice_date DESC, created_at DESC) FILTER (WHERE inside))[1] AS supplier,
                count(*) FILTER (WHERE inside)::int AS times
           FROM b GROUP BY product_id HAVING count(*) FILTER (WHERE inside) > 0`,
        [req.user.tid, q.from, q.to, q.storeId ?? null],
      ),
    ]);
    const moves = prices.rows.map((r) => {
      const was = r.before !== null ? N(r.before) : N(r.first);
      const now = N(r.last);
      return { id: r.product_id, name: r.name, unit: r.unit, supplier: r.supplier, times: r.times, wasMinor: was, nowMinor: now, pct: was ? Math.round(((now - was) / was) * 1000) / 10 : 0 };
    }).filter((m) => m.wasMinor !== m.nowMinor).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    return {
      owed: owed.rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, balanceMinor: N(r.balance_minor), lastInvoice: r.last_invoice, lastPaid: r.last_paid, boughtMinor: N(r.bought) })),
      owedMinor: owed.rows.reduce((a, r) => a + Math.max(0, N(r.balance_minor)), 0),
      priceMoves: moves.slice(0, 200),
      upCount: moves.filter((m) => m.pct > 0).length, downCount: moves.filter((m) => m.pct < 0).length,
    };
  });

  /**
   * Discounts, returns, carts cancelled at the till and prices typed by hand, per person, with the
   * biggest single ones: where money can slip away.
   */
  app.get("/reports/controls", managers, async (req) => {
    const q = period.parse(req.query);
    checkPeriod(q.from, q.to);
    await ownStore(req.user.tid, q.storeId);
    const args = [req.user.tid, q.storeId ?? null, q.from, q.to];
    const inS = `s.tenant_id = $1 AND ($2::uuid IS NULL OR s.store_id = $2) AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date`;
    // The till's own events: a cancelled cart has no sale, so it is matched to a branch by its device.
    const inA = `a.tenant_id = $1 AND (a.created_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM devices d WHERE d.id = a.device_id AND d.store_id = $2))`;
    const [people, events] = await Promise.all([
      app.db.query(
        `WITH s AS (
           SELECT s.user_id, count(*) FILTER (WHERE s.kind = 'sale')::int AS sales, COALESCE(sum(s.total_minor) FILTER (WHERE s.kind = 'sale'), 0)::bigint AS sold,
                  count(*) FILTER (WHERE s.kind = 'return')::int AS returns, COALESCE(-sum(s.total_minor) FILTER (WHERE s.kind = 'return'), 0)::bigint AS returned,
                  count(*) FILTER (WHERE s.kind = 'sale' AND s.discount_minor > 0)::int AS discounts,
                  COALESCE(sum(s.discount_minor) FILTER (WHERE s.kind = 'sale'), 0)::bigint AS discounted
             FROM sales s WHERE ${inS} GROUP BY s.user_id
         ), a AS (
           SELECT a.user_id, count(*) FILTER (WHERE a.action = 'sale.void')::int AS voids,
                  COALESCE(sum((a.data->>'totalMinor')::bigint) FILTER (WHERE a.action = 'sale.void'), 0)::bigint AS voided,
                  count(*) FILTER (WHERE a.action = 'sale.price_mismatch')::int AS overrides
             FROM audit_log a WHERE ${inA} AND a.action IN ('sale.void', 'sale.price_mismatch') GROUP BY a.user_id
         )
         SELECT u.id, u.name, COALESCE(s.sales, 0) AS sales, COALESCE(s.sold, 0)::bigint AS sold, COALESCE(s.returns, 0) AS returns, COALESCE(s.returned, 0)::bigint AS returned,
                COALESCE(s.discounts, 0) AS discounts, COALESCE(s.discounted, 0)::bigint AS discounted, COALESCE(a.voids, 0) AS voids, COALESCE(a.voided, 0)::bigint AS voided,
                COALESCE(a.overrides, 0) AS overrides
           FROM users u LEFT JOIN s ON s.user_id = u.id LEFT JOIN a ON a.user_id = u.id
          WHERE u.tenant_id = $1 AND (s.user_id IS NOT NULL OR a.user_id IS NOT NULL) ORDER BY 4 DESC`, args),
      app.db.query(
        `SELECT * FROM (
           SELECT 'return' AS kind, s.created_at AS at, u.name AS who, s.number AS ref, -s.total_minor AS amount, NULL::text AS detail
             FROM sales s JOIN users u ON u.id = s.user_id WHERE ${inS} AND s.kind = 'return'
           UNION ALL
           SELECT 'discount', s.created_at, u.name, s.number, s.discount_minor, NULL
             FROM sales s JOIN users u ON u.id = s.user_id WHERE ${inS} AND s.kind = 'sale' AND s.discount_minor > 0
           UNION ALL
           SELECT CASE a.action WHEN 'sale.void' THEN 'void' ELSE 'price' END, a.created_at, u.name, a.data->>'sale',
                  COALESCE((a.data->>'totalMinor')::bigint, 0), CASE WHEN a.action = 'sale.void' THEN a.data->>'items' ELSE a.data->>'overrides' END
             FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${inA} AND a.action IN ('sale.void', 'sale.price_mismatch')
         ) e ORDER BY amount DESC, at DESC LIMIT 100`, args),
    ]);
    const list = people.rows.map((r) => ({
      id: r.id, name: r.name, sales: r.sales, soldMinor: N(r.sold), returns: r.returns, returnedMinor: N(r.returned), discounts: r.discounts, discountedMinor: N(r.discounted),
      voids: r.voids, voidedMinor: N(r.voided), overrides: r.overrides,
    }));
    const sum = (k: "returnedMinor" | "discountedMinor" | "voidedMinor" | "soldMinor") => list.reduce((a, p) => a + p[k], 0);
    return {
      totals: { soldMinor: sum("soldMinor"), returnedMinor: sum("returnedMinor"), discountedMinor: sum("discountedMinor"), voidedMinor: sum("voidedMinor"), voids: list.reduce((a, p) => a + p.voids, 0), overrides: list.reduce((a, p) => a + p.overrides, 0) },
      people: list,
      events: events.rows.map((e) => ({ kind: e.kind, at: e.at, who: e.who, ref: e.ref, amountMinor: N(e.amount), detail: e.detail })),
    };
  });

  /** A cart cancelled at the till: kept so the owner sees who cancels what. */
  app.post("/sales/voids", { preHandler: requireDevice }, async (req) => {
    const b = z.object({
      id: z.string().uuid(), at: z.string().datetime(), totalMinor: z.number().int().min(0).max(1e12), lines: z.number().int().min(0).max(10_000),
      items: z.string().max(500).default(""),
    }).parse(req.body);
    const seen = await app.db.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'sale.void' AND entity_id = $2`, [req.user.tid, b.id]);
    if (!seen.rowCount) {
      // Dated by the till's own clock: a cart cancelled offline reaches the server later.
      await app.db.query(
        `INSERT INTO audit_log (tenant_id, user_id, device_id, action, entity, entity_id, data, created_at) VALUES ($1, $2, $3, 'sale.void', 'sale', $4, $5, $6)`,
        [req.user.tid, req.user.sub, req.user.did, b.id, JSON.stringify({ totalMinor: b.totalMinor, lines: b.lines, items: b.items }), b.at],
      );
    }
    return { ok: true };
  });

  /** Every branch side by side: sales, profit, average invoice, returns and expenses. */
  app.get("/reports/branches-full", managers, async (req) => {
    const q = z.object({ from: dateStr, to: dateStr }).parse(req.query);
    checkPeriod(q.from, q.to);
    const stores = (await app.db.query(`SELECT id, name, active FROM stores WHERE tenant_id = $1 ORDER BY created_at`, [req.user.tid])).rows;
    const out = [];
    for (const s of stores) {
      const t = await periodTotals(app.db, req.user.tid, q.from, q.to, s.id);
      const r = (await app.db.query(
        `SELECT COALESCE(-sum(total_minor) FILTER (WHERE kind = 'return'), 0)::bigint AS returned, count(DISTINCT customer_id)::int AS customers
           FROM sales WHERE tenant_id = $1 AND store_id = $2 AND (created_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date`,
        [req.user.tid, s.id, q.from, q.to],
      )).rows[0];
      out.push({ id: s.id, name: s.name, active: s.active, ...t, returnedMinor: N(r.returned), customers: r.customers });
    }
    return out;
  });

  /**
   * Where the month is heading (by weekday, from the last eight weeks) and the items that will run
   * out soon at the pace of the last 30 days.
   */
  app.get("/reports/forecast", managers, async (req) => {
    const q = z.object({ storeId: z.string().uuid().optional() }).parse(req.query);
    await ownStore(req.user.tid, q.storeId);
    const tid = req.user.tid, sid = q.storeId ?? null;
    const today = libyaDay();
    const month = today.slice(0, 7);
    const first = `${month}-01`;
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const lmEnd = addDays(first, -1);
    const lmFirst = `${lmEnd.slice(0, 7)}-01`;
    const lyFirst = `${Number(month.slice(0, 4)) - 1}${first.slice(4)}`;
    const lyLast = new Date(Date.UTC(Number(month.slice(0, 4)) - 1, Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const [soFar, lastMonth, lastYear, weeks, stock] = await Promise.all([
      periodTotals(app.db, tid, first, today, sid),
      periodTotals(app.db, tid, lmFirst, lmEnd, sid),
      periodTotals(app.db, tid, lyFirst, lyLast, sid),
      app.db.query(
        `SELECT extract(dow FROM (s.created_at AT TIME ZONE '${TZ}'))::int AS dow, sum(s.total_minor)::bigint AS total,
                count(DISTINCT (s.created_at AT TIME ZONE '${TZ}')::date)::int AS days
           FROM sales s WHERE s.tenant_id = $1 AND ($2::uuid IS NULL OR s.store_id = $2)
            AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date GROUP BY 1`,
        [tid, sid, addDays(today, -56), addDays(today, -1)],
      ),
      app.db.query(
        `SELECT p.id, p.name, p.is_weighted, p.min_stock_milli,
                COALESCE((SELECT sum(m.qty_milli) FROM stock_movements m WHERE m.product_id = p.id AND ($2::uuid IS NULL OR m.store_id = $2)), 0)::bigint AS stock,
                COALESCE((SELECT sum(l.qty_milli * u.factor_milli / 1000) FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN product_units u ON u.id = l.unit_id
                           WHERE l.product_id = p.id AND ($2::uuid IS NULL OR s.store_id = $2) AND s.created_at > now() - interval '30 days'), 0)::bigint AS sold30
           FROM products p WHERE p.tenant_id = $1 AND p.active AND NOT COALESCE(p.is_service, false)`,
        [tid, sid],
      ),
    ]);
    // The rest of the month, one day at a time, at each weekday's usual takings.
    const perDow = new Map(weeks.rows.map((r) => [r.dow as number, r.days ? N(r.total) / 8 : 0]));
    let rest = 0;
    for (let d = addDays(today, 1); d <= last; d = addDays(d, 1)) rest += perDow.get(new Date(`${d}T12:00:00Z`).getUTCDay()) ?? 0;
    // Today is not over: count what is left of it by the hour.
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    const todayUsual = perDow.get(new Date(`${today}T12:00:00Z`).getUTCDay()) ?? 0;
    const todayMade = (await periodTotals(app.db, tid, today, today, sid)).totalMinor;
    const todayLeft = Math.max(0, todayUsual * Math.max(0, (22 - hour) / 14) - Math.max(0, todayMade - todayUsual * Math.min(1, Math.max(0, (hour - 8) / 14))));
    const projected = Math.round(soFar.totalMinor + rest + todayLeft);
    const days = daysBetween(first, today) + 1;
    const runningOut = stock.rows
      .map((r) => ({ id: r.id, name: r.name, weighted: r.is_weighted, stockMilli: N(r.stock), perDayMilli: N(r.sold30) / 30, minMilli: N(r.min_stock_milli) }))
      .filter((r) => r.perDayMilli > 0)
      .map((r) => ({ ...r, perDayMilli: Math.round(r.perDayMilli), daysLeft: r.stockMilli <= 0 ? 0 : Math.floor(r.stockMilli / r.perDayMilli) }))
      .filter((r) => r.daysLeft <= 21)
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 100);
    return {
      month, today, daysGone: days, daysInMonth: daysBetween(first, last) + 1,
      soFar, projectedMinor: projected, paceMinor: Math.round((soFar.totalMinor / days) * (daysBetween(first, last) + 1)),
      lastMonth, lastYear, runningOut,
    };
  });

  /** A till's heartbeat and the owner's home page both look whether a summary is due. */
  app.post("/reports/digest/check", managers, async (req) => {
    const n = await checkDigest(app.db, req.user.tid);
    if (n) await flushPushes(app.db, req.user.tid).catch(() => undefined);
    return { sent: n };
  });
}

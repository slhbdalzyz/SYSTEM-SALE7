import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requirePerm } from "../auth";

export async function reportRoutes(app: FastifyInstance) {
  /** Day summary for one store, using the store's local day (Libya by default). */
  app.get("/reports/daily", { preHandler: requirePerm("reports") }, async (req) => {
    const q = z
      .object({ storeId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tz: z.string().default("Africa/Tripoli") })
      .parse(req.query);
    const args = [req.user.tid, q.storeId, q.date, q.tz];
    const day = `s.tenant_id = $1 AND s.store_id = $2 AND (s.created_at AT TIME ZONE $4)::date = $3::date`;
    const [summary, byMethod, byCashier, top, byHour] = await Promise.all([
      app.db.query(
        `SELECT count(*) FILTER (WHERE kind = 'sale')::int AS sales_count,
           count(*) FILTER (WHERE kind = 'return')::int AS returns_count,
           COALESCE(-sum(total_minor) FILTER (WHERE kind = 'return'),0)::bigint AS returns_minor,
           COALESCE(sum(total_minor),0)::bigint AS total_minor, COALESCE(sum(discount_minor),0)::bigint AS discount_minor,
           COALESCE(sum(tax_minor),0)::bigint AS tax_minor,
           COALESCE((SELECT sum(l.total_minor - l.cost_minor) FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE ${day}),0)::bigint AS gross_profit_minor,
           COALESCE((SELECT sum(l.promo_minor) FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE ${day}),0)::bigint AS promo_minor
         FROM sales s WHERE ${day}`,
        args,
      ),
      app.db.query(
        `SELECT p.method, sum(p.amount_minor)::bigint AS amount_minor FROM payments p JOIN sales s ON s.id = p.sale_id WHERE ${day} GROUP BY p.method`,
        args,
      ),
      app.db.query(
        `SELECT u.name, count(*)::int AS sales_count, sum(s.total_minor)::bigint AS total_minor FROM sales s JOIN users u ON u.id = s.user_id WHERE ${day} GROUP BY u.name ORDER BY 3 DESC`,
        args,
      ),
      app.db.query(
        `SELECT l.product_id, max(l.name) AS name, sum(l.qty_milli)::bigint AS qty_milli, sum(l.total_minor)::bigint AS total_minor
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE ${day} GROUP BY l.product_id ORDER BY 4 DESC LIMIT 10`,
        args,
      ),
      app.db.query(
        `SELECT extract(hour FROM s.created_at AT TIME ZONE $4)::int AS hour, count(*)::int AS sales_count, sum(s.total_minor)::bigint AS total_minor
         FROM sales s WHERE ${day} GROUP BY 1 ORDER BY 1`,
        args,
      ),
    ]);
    const collected = await app.db.query(
      `SELECT cp.method, sum(cp.amount_minor)::bigint AS amount_minor FROM customer_payments cp
       WHERE cp.tenant_id = $1 AND cp.store_id = $2 AND (cp.created_at AT TIME ZONE $4)::date = $3::date GROUP BY cp.method`,
      args,
    );
    const change = await app.db.query(`SELECT COALESCE(sum(change_minor),0)::bigint AS c FROM sales s WHERE ${day}`, args);
    const methods = Object.fromEntries(byMethod.rows.map((r) => [r.method, r.amount_minor]));
    if (methods.cash) methods.cash -= change.rows[0].c; // net cash kept, after change given back
    const customerPayments = Object.fromEntries(collected.rows.map((r) => [r.method, r.amount_minor]));
    return { ...summary.rows[0], byMethod: methods, customerPayments, byCashier: byCashier.rows, topProducts: top.rows, byHour: byHour.rows };
  });

  const managers = { preHandler: requirePerm("reports") };
  const tz = z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/).default("Africa/Tripoli");
  const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  async function ownStore(tid: string, storeId: string | undefined) {
    if (!storeId) return;
    if (!(await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [storeId, tid])).rowCount) throw new HttpError(404, "الفرع غير موجود");
  }

  /**
   * Everything the reports screen draws for a period, one branch or (without storeId) all of
   * them: sales and profit per day, payment methods, hours and weekdays, departments, items,
   * cashiers, expenses, purchases per supplier, and credit given and collected.
   * Days are the shop's local days.
   */
  app.get("/reports/period", managers, async (req) => {
    const q = z.object({ storeId: z.string().uuid().optional(), from: dateStr, to: dateStr, tz }).parse(req.query);
    if (q.from > q.to) throw new HttpError(400, "بداية الفترة بعد نهايتها");
    if ((Date.parse(q.to) - Date.parse(q.from)) / 864e5 > 366) throw new HttpError(400, "الفترة أطول من سنة");
    await ownStore(req.user.tid, q.storeId);
    const args = [req.user.tid, q.storeId ?? null, q.from, q.to, q.tz];
    const args4 = args.slice(0, 4); // for the queries on plain dates, which have no time zone
    const inPeriod = (a: string, col = "created_at") => `${a}.tenant_id = $1 AND ($2::uuid IS NULL OR ${a}.store_id = $2) AND (${a}.${col} AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date`;
    const S = inPeriod("s");
    const [summary, days, methods, change, hours, weekdays, cats, top, cashiers, expenses, purchases, purchaseMethods, credit] = await Promise.all([
      app.db.query(
        `SELECT count(*) FILTER (WHERE s.kind = 'sale')::int AS sales_count, count(*) FILTER (WHERE s.kind = 'return')::int AS returns_count,
           COALESCE(-sum(s.total_minor) FILTER (WHERE s.kind = 'return'), 0)::bigint AS returns_minor,
           COALESCE(sum(s.total_minor), 0)::bigint AS total_minor, COALESCE(sum(s.discount_minor), 0)::bigint AS discount_minor,
           COALESCE((SELECT sum(l.cost_minor) FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE ${S}), 0)::bigint AS cost_minor,
           COALESCE((SELECT sum(l.total_minor - l.cost_minor) FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE ${S}), 0)::bigint AS profit_minor,
           COALESCE((SELECT sum(l.promo_minor) FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE ${S}), 0)::bigint AS promo_minor
         FROM sales s WHERE ${S}`, args),
      app.db.query(
        `SELECT to_char(s.created_at AT TIME ZONE $5, 'YYYY-MM-DD') AS day, sum(s.total_minor)::bigint AS total_minor, count(*) FILTER (WHERE s.kind = 'sale')::int AS sales_count,
           COALESCE(sum((SELECT sum(l.total_minor - l.cost_minor) FROM sale_lines l WHERE l.sale_id = s.id)), 0)::bigint AS profit_minor
         FROM sales s WHERE ${S} GROUP BY 1`, args),
      app.db.query(`SELECT p.method, sum(p.amount_minor)::bigint AS amount_minor FROM payments p JOIN sales s ON s.id = p.sale_id WHERE ${S} GROUP BY 1`, args),
      app.db.query(`SELECT COALESCE(sum(s.change_minor), 0)::bigint AS c FROM sales s WHERE ${S}`, args),
      app.db.query(`SELECT extract(hour FROM s.created_at AT TIME ZONE $5)::int AS hour, count(*)::int AS sales_count, sum(s.total_minor)::bigint AS total_minor FROM sales s WHERE ${S} AND s.kind = 'sale' GROUP BY 1 ORDER BY 1`, args),
      app.db.query(`SELECT extract(dow FROM s.created_at AT TIME ZONE $5)::int AS dow, count(*)::int AS sales_count, sum(s.total_minor)::bigint AS total_minor FROM sales s WHERE ${S} AND s.kind = 'sale' GROUP BY 1 ORDER BY 1`, args),
      app.db.query(
        `SELECT c.id, COALESCE(c.name, 'بدون قسم') AS name, c.icon, sum(l.total_minor)::bigint AS total_minor, sum(l.total_minor - l.cost_minor)::bigint AS profit_minor, count(DISTINCT l.product_id)::int AS products
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id LEFT JOIN products p ON p.id = l.product_id LEFT JOIN categories c ON c.id = p.category_id
         WHERE ${S} GROUP BY c.id, c.name, c.icon ORDER BY 4 DESC`, args),
      app.db.query(
        `SELECT l.product_id, max(l.name) AS name, bool_or(p.is_weighted) AS weighted, sum(l.qty_milli)::bigint AS qty_milli, sum(l.total_minor)::bigint AS total_minor, sum(l.total_minor - l.cost_minor)::bigint AS profit_minor
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id LEFT JOIN products p ON p.id = l.product_id
         WHERE ${S} GROUP BY l.product_id ORDER BY 5 DESC LIMIT 20`, args),
      app.db.query(
        `SELECT u.name, count(*) FILTER (WHERE s.kind = 'sale')::int AS sales_count, sum(s.total_minor)::bigint AS total_minor, count(*) FILTER (WHERE s.kind = 'return')::int AS returns_count
         FROM sales s JOIN users u ON u.id = s.user_id WHERE ${S} GROUP BY u.name ORDER BY 3 DESC`, args),
      app.db.query(
        `SELECT e.category, sum(e.amount_minor)::bigint AS amount_minor FROM expenses e
         WHERE e.tenant_id = $1 AND ($2::uuid IS NULL OR e.store_id = $2) AND e.spent_on BETWEEN $3::date AND $4::date GROUP BY 1 ORDER BY 2 DESC`, args4),
      app.db.query(
        `SELECT s.id, COALESCE(s.name, 'بدون مورد') AS name, count(*)::int AS invoices, sum(i.total_minor)::bigint AS total_minor,
           COALESCE(sum((SELECT sum(p.amount_minor) FROM supplier_payments p WHERE p.invoice_id = i.id)), 0)::bigint AS paid_minor
         FROM purchase_invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id
         WHERE i.tenant_id = $1 AND ($2::uuid IS NULL OR i.store_id = $2) AND i.invoice_date BETWEEN $3::date AND $4::date
         GROUP BY s.id, s.name ORDER BY 4 DESC`, args4),
      app.db.query(
        `SELECT i.payment_method AS method, count(*)::int AS invoices, sum(i.total_minor)::bigint AS total_minor FROM purchase_invoices i
         WHERE i.tenant_id = $1 AND ($2::uuid IS NULL OR i.store_id = $2) AND i.invoice_date BETWEEN $3::date AND $4::date GROUP BY 1`, args4),
      app.db.query(
        `SELECT COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales s ON s.id = p.sale_id WHERE ${S} AND p.method = 'credit'), 0)::bigint AS given_minor,
           COALESCE((SELECT sum(cp.amount_minor) FROM customer_payments cp WHERE ${inPeriod("cp")}), 0)::bigint AS collected_minor`, args),
    ]);

    // Every day of the period, with zeros for days without sales.
    const byDay = new Map(days.rows.map((r) => [r.day as string, r]));
    const series: { day: string; totalMinor: number; profitMinor: number; salesCount: number }[] = [];
    for (let d = new Date(`${q.from}T12:00:00Z`); d.toISOString().slice(0, 10) <= q.to; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = d.toISOString().slice(0, 10);
      const r = byDay.get(k);
      series.push({ day: k, totalMinor: Number(r?.total_minor ?? 0), profitMinor: Number(r?.profit_minor ?? 0), salesCount: r?.sales_count ?? 0 });
    }
    const m = Object.fromEntries(methods.rows.map((r) => [r.method, Number(r.amount_minor)]));
    if (m.cash) m.cash -= Number(change.rows[0].c);
    const sum = summary.rows[0];
    const total = Number(sum.total_minor);
    const cost = Number(sum.cost_minor);
    const expenseTotal = expenses.rows.reduce((a, r) => a + Number(r.amount_minor), 0);
    const n = (r: Record<string, unknown>, ...keys: string[]) => ({ ...r, ...Object.fromEntries(keys.map((k) => [k, Number(r[k])])) });
    return {
      from: q.from, to: q.to,
      summary: {
        salesCount: sum.sales_count, returnsCount: sum.returns_count, returnsMinor: Number(sum.returns_minor),
        totalMinor: total, discountMinor: Number(sum.discount_minor), promoMinor: Number(sum.promo_minor),
        // Profit is worked out on the lines, like the day report and the owner's phone screen.
        costMinor: cost, grossProfitMinor: Number(sum.profit_minor), expensesMinor: expenseTotal, netProfitMinor: Number(sum.profit_minor) - expenseTotal,
        avgMinor: sum.sales_count ? Math.round(total / sum.sales_count) : 0,
      },
      series,
      byMethod: m,
      byHour: hours.rows.map((r) => n(r, "total_minor")),
      byWeekday: weekdays.rows.map((r) => n(r, "total_minor")),
      byCategory: cats.rows.map((r) => n(r, "total_minor", "profit_minor")),
      topProducts: top.rows.map((r) => n(r, "qty_milli", "total_minor", "profit_minor")),
      byCashier: cashiers.rows.map((r) => n(r, "total_minor")),
      expenses: expenses.rows.map((r) => n(r, "amount_minor")),
      purchases: { bySupplier: purchases.rows.map((r) => n(r, "total_minor", "paid_minor")), byMethod: purchaseMethods.rows.map((r) => n(r, "total_minor")) },
      credit: { givenMinor: Number(credit.rows[0].given_minor), collectedMinor: Number(credit.rows[0].collected_minor) },
    };
  });

  /**
   * What is on the shelves now: stock value at cost and at selling price per department, items
   * that are out, and items in stock that sold nothing in the last 30 days.
   */
  app.get("/reports/inventory", managers, async (req) => {
    const q = z.object({ storeId: z.string().uuid().optional() }).parse(req.query);
    await ownStore(req.user.tid, q.storeId);
    const rows = (await app.db.query(
      `WITH stock AS (
         SELECT p.id, p.name, p.is_weighted, p.cost_minor, p.category_id, bu.price_minor,
                COALESCE((SELECT sum(m.qty_milli) FROM stock_movements m WHERE m.product_id = p.id AND ($2::uuid IS NULL OR m.store_id = $2)), 0)::bigint AS stock_milli,
                EXISTS (SELECT 1 FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE l.product_id = p.id AND s.created_at > now() - interval '30 days' AND ($2::uuid IS NULL OR s.store_id = $2)) AS sold_recently
         FROM products p JOIN product_units bu ON bu.product_id = p.id AND bu.is_base
         WHERE p.tenant_id = $1 AND p.active
       )
       SELECT st.*, c.name AS category, c.icon FROM stock st LEFT JOIN categories c ON c.id = st.category_id`,
      [req.user.tid, q.storeId ?? null],
    )).rows;
    const depts = new Map<string, { name: string; icon: string | null; items: number; inStock: number; costValueMinor: number; retailValueMinor: number }>();
    let out = 0;
    const slow: { id: string; name: string; stockMilli: number; weighted: boolean; costValueMinor: number }[] = [];
    for (const r of rows) {
      const k = r.category ?? "بدون قسم";
      const d = depts.get(k) ?? { name: k, icon: r.icon, items: 0, inStock: 0, costValueMinor: 0, retailValueMinor: 0 };
      const qty = Number(r.stock_milli);
      d.items++;
      if (qty > 0) {
        d.inStock++;
        d.costValueMinor += Math.round((qty * Number(r.cost_minor)) / 1000);
        d.retailValueMinor += Math.round((qty * Number(r.price_minor)) / 1000);
        if (!r.sold_recently) slow.push({ id: r.id, name: r.name, stockMilli: qty, weighted: r.is_weighted, costValueMinor: Math.round((qty * Number(r.cost_minor)) / 1000) });
      } else out++;
      depts.set(k, d);
    }
    const list = [...depts.values()].sort((a, b) => b.costValueMinor - a.costValueMinor);
    return {
      items: rows.length, outOfStock: out,
      costValueMinor: list.reduce((a, d) => a + d.costValueMinor, 0),
      retailValueMinor: list.reduce((a, d) => a + d.retailValueMinor, 0),
      byCategory: list,
      slowMovers: slow.sort((a, b) => b.costValueMinor - a.costValueMinor).slice(0, 20),
    };
  });

  /**
   * Clothes: for each model, how many pieces of each colour and size sold in the period (returns
   * taken off) and how many are left, so the next order brings the sizes that move.
   */
  app.get("/reports/sizes", managers, async (req) => {
    const q = z.object({ storeId: z.string().uuid().optional(), from: dateStr, to: dateStr, tz }).parse(req.query);
    if (q.from > q.to) throw new HttpError(400, "بداية الفترة بعد نهايتها");
    if ((Date.parse(q.to) - Date.parse(q.from)) / 864e5 > 366) throw new HttpError(400, "الفترة أطول من سنة");
    await ownStore(req.user.tid, q.storeId);
    const rows = (await app.db.query(
      `SELECT p.id, p.group_id, p.name, p.attrs,
         COALESCE((SELECT sum(l.qty_milli * u.factor_milli / 1000) FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN product_units u ON u.id = l.unit_id
                   WHERE l.product_id = p.id AND s.tenant_id = $1 AND ($2::uuid IS NULL OR s.store_id = $2)
                     AND (s.created_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date), 0)::bigint AS sold_milli,
         COALESCE((SELECT sum(l.total_minor) FROM sale_lines l JOIN sales s ON s.id = l.sale_id
                   WHERE l.product_id = p.id AND s.tenant_id = $1 AND ($2::uuid IS NULL OR s.store_id = $2)
                     AND (s.created_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date), 0)::bigint AS total_minor,
         COALESCE((SELECT sum(m.qty_milli) FROM stock_movements m WHERE m.product_id = p.id AND ($2::uuid IS NULL OR m.store_id = $2)), 0)::bigint AS stock_milli
       FROM products p
       WHERE p.tenant_id = $1 AND p.group_id IS NOT NULL AND p.attrs IS NOT NULL AND p.active`,
      [req.user.tid, q.storeId ?? null, q.from, q.to, q.tz],
    )).rows;
    type Model = { groupId: string; name: string; soldMilli: number; totalMinor: number; stockMilli: number; pieces: { productId: string; color: string | null; size: string | null; soldMilli: number; stockMilli: number }[] };
    const models = new Map<string, Model>();
    for (const r of rows) {
      const a = (r.attrs ?? {}) as Record<string, string>;
      let name = r.name as string;
      for (const v of [a.size, a.color]) if (v && name.endsWith(` - ${v}`)) name = name.slice(0, -(v.length + 3));
      const m: Model = models.get(r.group_id) ?? { groupId: r.group_id, name, soldMilli: 0, totalMinor: 0, stockMilli: 0, pieces: [] };
      m.soldMilli += Number(r.sold_milli);
      m.totalMinor += Number(r.total_minor);
      m.stockMilli += Number(r.stock_milli);
      m.pieces.push({ productId: r.id, color: a.color ?? null, size: a.size ?? null, soldMilli: Number(r.sold_milli), stockMilli: Number(r.stock_milli) });
      models.set(r.group_id, m);
    }
    return [...models.values()].sort((x, y) => y.soldMilli - x.soldMilli || y.stockMilli - x.stockMilli);
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth";

export async function reportRoutes(app: FastifyInstance) {
  /** Day summary for one store, using the store's local day (Libya by default). */
  app.get("/reports/daily", { preHandler: requireRole("owner", "manager") }, async (req) => {
    const q = z
      .object({ storeId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tz: z.string().default("Africa/Tripoli") })
      .parse(req.query);
    const args = [req.user.tid, q.storeId, q.date, q.tz];
    const day = `s.tenant_id = $1 AND s.store_id = $2 AND (s.created_at AT TIME ZONE $4)::date = $3::date`;
    const [summary, byMethod, byCashier, top, byHour] = await Promise.all([
      app.db.query(
        `SELECT count(*)::int AS sales_count, COALESCE(sum(total_minor),0)::bigint AS total_minor, COALESCE(sum(discount_minor),0)::bigint AS discount_minor,
           COALESCE(sum(tax_minor),0)::bigint AS tax_minor,
           COALESCE((SELECT sum(l.total_minor - l.cost_minor) FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE ${day}),0)::bigint AS gross_profit_minor
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
    const change = await app.db.query(`SELECT COALESCE(sum(change_minor),0)::bigint AS c FROM sales s WHERE ${day}`, args);
    const methods = Object.fromEntries(byMethod.rows.map((r) => [r.method, r.amount_minor]));
    if (methods.cash) methods.cash -= change.rows[0].c; // net cash kept, after change given back
    return { ...summary.rows[0], byMethod: methods, byCashier: byCashier.rows, topProducts: top.rows, byHour: byHour.rows };
  });
}

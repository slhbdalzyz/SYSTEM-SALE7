import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requirePerm } from "../auth";

const TZ = "Africa/Tripoli";
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Sales and invoices: every invoice the tills issued (and every return), when, on which till, in
 * which shift and by whom; one invoice in full, to look at or print again; and the shifts.
 */
export async function invoiceRoutes(app: FastifyInstance) {
  const allowed = { preHandler: requirePerm("sales", "reports") };

  app.get("/invoices", allowed, async (req) => {
    const q = z.object({
      from: z.string().regex(dateRe),
      to: z.string().regex(dateRe),
      storeId: z.string().uuid().optional(),
      shiftId: z.string().uuid().optional(),
      userId: z.string().uuid().optional(),
      kind: z.enum(["sale", "return"]).optional(),
      method: z.enum(["cash", "card", "credit", "payroll"]).optional(),
      q: z.string().trim().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    if (q.from > q.to) throw new HttpError(400, "تاريخ البداية بعد النهاية");
    const where = `s.tenant_id = $1 AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR s.store_id = $4) AND ($5::uuid IS NULL OR s.shift_id = $5) AND ($6::uuid IS NULL OR s.user_id = $6)
      AND ($7::text IS NULL OR s.kind = $7)
      AND ($8::text IS NULL OR EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.method = $8))
      AND ($9::text IS NULL OR s.number ILIKE '%' || $9 || '%' OR c.name ILIKE '%' || $9 || '%')`;
    const args = [req.user.tid, q.from, q.to, q.storeId ?? null, q.shiftId ?? null, q.userId ?? null, q.kind ?? null, q.method ?? null, q.q || null];
    const rows = (await app.db.query(
      `SELECT s.id, s.number, s.kind, s.created_at, s.total_minor, s.discount_minor, s.shift_id, s.original_sale_id,
              st.name AS store_name, d.name AS device_name, u.name AS cashier, c.name AS customer_name, e.name AS employee_name,
              sh.opened_at AS shift_opened_at, sh.closed_at AS shift_closed_at,
              (SELECT count(*)::int FROM sale_lines l WHERE l.sale_id = s.id) AS lines,
              COALESCE((SELECT json_agg(json_build_object('method', p.method, 'amount', p.amount_minor)) FROM payments p WHERE p.sale_id = s.id), '[]') AS payments,
              COALESCE((SELECT -sum(r.total_minor) FROM sales r WHERE r.original_sale_id = s.id), 0)::bigint AS returned_minor
         FROM sales s JOIN stores st ON st.id = s.store_id JOIN devices d ON d.id = s.device_id JOIN users u ON u.id = s.user_id
         LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users e ON e.id = s.employee_id LEFT JOIN shifts sh ON sh.id = s.shift_id
        WHERE ${where}
        ORDER BY s.created_at DESC LIMIT $10 OFFSET $11`,
      [...args, q.limit, q.offset],
    )).rows;
    const sum = (await app.db.query(
      `SELECT count(*) FILTER (WHERE s.kind = 'sale')::int AS sales, count(*) FILTER (WHERE s.kind = 'return')::int AS returns,
              COALESCE(sum(s.total_minor) FILTER (WHERE s.kind = 'sale'), 0)::bigint AS sales_minor,
              COALESCE(-sum(s.total_minor) FILTER (WHERE s.kind = 'return'), 0)::bigint AS returns_minor,
              COALESCE(sum(s.discount_minor) FILTER (WHERE s.kind = 'sale'), 0)::bigint AS discount_minor
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE ${where}`,
      args,
    )).rows[0];
    const byMethod = (await app.db.query(
      `SELECT p.method, sum(p.amount_minor - CASE WHEN p.method = 'cash' AND s.kind = 'sale' THEN s.change_minor ELSE 0 END)::bigint AS amount
         FROM payments p JOIN sales s ON s.id = p.sale_id LEFT JOIN customers c ON c.id = s.customer_id WHERE ${where} GROUP BY p.method`,
      args,
    )).rows;
    return {
      rows: rows.map((r) => ({ ...r, total_minor: Number(r.total_minor), discount_minor: Number(r.discount_minor), returned_minor: Number(r.returned_minor) })),
      summary: {
        sales: sum.sales as number, returns: sum.returns as number, salesMinor: Number(sum.sales_minor), returnsMinor: Number(sum.returns_minor),
        netMinor: Number(sum.sales_minor) - Number(sum.returns_minor), discountMinor: Number(sum.discount_minor),
        byMethod: Object.fromEntries(byMethod.map((m) => [m.method, Number(m.amount)])) as Record<string, number>,
      },
    };
  });

  /** One invoice in full: lines, payments, the shift it was made in, and any returns against it. */
  app.get("/invoices/:id", allowed, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const s = (await app.db.query(
      `SELECT s.id, s.number, s.kind, s.created_at, s.received_at, s.subtotal_minor, s.discount_minor, s.tax_minor, s.total_minor, s.paid_minor, s.change_minor,
              s.shift_id, s.reason, s.original_sale_id, s.customer_id, s.employee_id, o.number AS original_number,
              st.name AS store_name, st.receipt_footer, d.name AS device_name, u.name AS cashier, c.name AS customer_name, e.name AS employee_name, a.name AS approved_by_name,
              sh.opened_at AS shift_opened_at, sh.closed_at AS shift_closed_at, su.name AS shift_cashier
         FROM sales s JOIN stores st ON st.id = s.store_id JOIN devices d ON d.id = s.device_id JOIN users u ON u.id = s.user_id
         LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users e ON e.id = s.employee_id LEFT JOIN users a ON a.id = s.approved_by
         LEFT JOIN sales o ON o.id = s.original_sale_id LEFT JOIN shifts sh ON sh.id = s.shift_id LEFT JOIN users su ON su.id = sh.user_id
        WHERE s.id = $1 AND s.tenant_id = $2`,
      [id, req.user.tid],
    )).rows[0];
    if (!s) throw new HttpError(404, "الفاتورة غير موجودة");
    const lines = (await app.db.query(
      `SELECT l.id, l.product_id, l.unit_id, l.name, l.qty_milli, l.price_minor, l.discount_minor, l.tax_minor, l.total_minor, l.promo_minor, l.offer_id, o.name AS offer_name, p.tax_bp
         FROM sale_lines l LEFT JOIN offers o ON o.id = l.offer_id LEFT JOIN products p ON p.id = l.product_id WHERE l.sale_id = $1 ORDER BY l.id`,
      [id],
    )).rows;
    const payments = (await app.db.query(`SELECT method, amount_minor FROM payments WHERE sale_id = $1`, [id])).rows;
    const returns = (await app.db.query(
      `SELECT r.id, r.number, r.created_at, -r.total_minor AS amount_minor, r.reason FROM sales r WHERE r.original_sale_id = $1 AND r.tenant_id = $2 ORDER BY r.created_at`,
      [id, req.user.tid],
    )).rows;
    const n = (x: unknown) => Number(x);
    return {
      ...s,
      subtotal_minor: n(s.subtotal_minor), discount_minor: n(s.discount_minor), tax_minor: n(s.tax_minor), total_minor: n(s.total_minor), paid_minor: n(s.paid_minor), change_minor: n(s.change_minor),
      lines: lines.map((l) => ({ ...l, qty_milli: n(l.qty_milli), price_minor: n(l.price_minor), discount_minor: n(l.discount_minor), tax_minor: n(l.tax_minor), total_minor: n(l.total_minor), promo_minor: n(l.promo_minor), tax_bp: n(l.tax_bp ?? 0) })),
      payments: payments.map((p) => ({ method: p.method, amount_minor: n(p.amount_minor) })),
      returns: returns.map((r) => ({ ...r, amount_minor: n(r.amount_minor) })),
    };
  });

  /** The shifts in a period: who worked which till, when, what they sold and how the drawer came out. */
  app.get("/shifts", allowed, async (req) => {
    const q = z.object({ from: z.string().regex(dateRe), to: z.string().regex(dateRe), storeId: z.string().uuid().optional() }).parse(req.query);
    const rows = (await app.db.query(
      `SELECT sh.id, sh.user_id, sh.opened_at, sh.closed_at, sh.opening_cash_minor, sh.closing_cash_minor, sh.expected_cash_minor,
              u.name AS cashier, d.name AS device_name, st.name AS store_name,
              count(s.id) FILTER (WHERE s.kind = 'sale')::int AS sales,
              COALESCE(sum(s.total_minor) FILTER (WHERE s.kind = 'sale'), 0)::bigint AS sales_minor,
              COALESCE(-sum(s.total_minor) FILTER (WHERE s.kind = 'return'), 0)::bigint AS returns_minor
         FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN devices d ON d.id = sh.device_id JOIN stores st ON st.id = sh.store_id
         LEFT JOIN sales s ON s.shift_id = sh.id
        WHERE sh.tenant_id = $1 AND ($4::uuid IS NULL OR sh.store_id = $4)
          AND (sh.opened_at AT TIME ZONE '${TZ}')::date <= $3::date
          AND (sh.closed_at IS NULL OR (sh.closed_at AT TIME ZONE '${TZ}')::date >= $2::date)
        GROUP BY sh.id, u.name, d.name, st.name ORDER BY sh.opened_at DESC LIMIT 300`,
      [req.user.tid, q.from, q.to, q.storeId ?? null],
    )).rows;
    return rows.map((r) => ({
      ...r,
      opening_cash_minor: Number(r.opening_cash_minor), closing_cash_minor: r.closing_cash_minor === null ? null : Number(r.closing_cash_minor),
      expected_cash_minor: r.expected_cash_minor === null ? null : Number(r.expected_cash_minor),
      sales_minor: Number(r.sales_minor), returns_minor: Number(r.returns_minor),
      difference_minor: r.closing_cash_minor === null || r.expected_cash_minor === null ? null : Number(r.closing_cash_minor) - Number(r.expected_cash_minor),
    }));
  });
}

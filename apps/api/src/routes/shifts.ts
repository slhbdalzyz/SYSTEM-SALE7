import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db";
import { HttpError, requireDevice } from "../auth";

export async function shiftRoutes(app: FastifyInstance) {
  async function expectedCash(shiftId: string) {
    const r = await app.db.query(
      `SELECT sh.opening_cash_minor
         + COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.shift_id = sh.id AND p.method = 'cash'), 0)
         - COALESCE((SELECT sum(s.change_minor) FROM sales s WHERE s.shift_id = sh.id), 0) AS expected,
         (SELECT count(*)::int FROM sales s WHERE s.shift_id = sh.id) AS sales_count,
         COALESCE((SELECT sum(s.total_minor) FROM sales s WHERE s.shift_id = sh.id), 0) AS sales_total
       FROM shifts sh WHERE sh.id = $1`,
      [shiftId],
    );
    return r.rows[0] as { expected: number; sales_count: number; sales_total: number };
  }

  app.get("/shifts/current", { preHandler: requireDevice }, async (req) => {
    const r = await app.db.query(
      `SELECT id, user_id, opened_at, opening_cash_minor FROM shifts WHERE tenant_id = $1 AND device_id = $2 AND closed_at IS NULL`,
      [req.user.tid, req.user.did],
    );
    if (!r.rowCount) return { shift: null };
    return { shift: { ...r.rows[0], ...(await expectedCash(r.rows[0].id)) } };
  });

  /** The device makes the shift id, so a shift opened offline can be sent later. */
  app.post("/shifts/open", { preHandler: requireDevice }, async (req) => {
    const b = z.object({ id: z.string().uuid(), openingCashMinor: z.number().int().nonnegative(), openedAt: z.string().datetime().optional() }).parse(req.body);
    const open = await app.db.query(`SELECT id FROM shifts WHERE tenant_id = $1 AND device_id = $2 AND closed_at IS NULL`, [req.user.tid, req.user.did]);
    if (open.rowCount && open.rows[0].id !== b.id) throw new HttpError(409, "فيه وردية مفتوحة على هذا الجهاز");
    if (open.rowCount) return { id: b.id };
    await app.db.query(
      `INSERT INTO shifts (id, tenant_id, store_id, device_id, user_id, opening_cash_minor, opened_at) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()))
       ON CONFLICT (id) DO NOTHING`,
      [b.id, req.user.tid, req.user.sid, req.user.did, req.user.sub, b.openingCashMinor, b.openedAt ?? null],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, deviceId: req.user.did, action: "shift.open", entity: "shift", entityId: b.id, data: { openingCash: b.openingCashMinor } });
    return { id: b.id };
  });

  app.post("/shifts/:id/close", { preHandler: requireDevice }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ closingCashMinor: z.number().int().nonnegative() }).parse(req.body);
    const sh = await app.db.query(`SELECT closed_at FROM shifts WHERE id = $1 AND tenant_id = $2 AND device_id = $3`, [id, req.user.tid, req.user.did]);
    if (!sh.rowCount) throw new HttpError(404, "الوردية غير موجودة");
    if (sh.rows[0].closed_at) throw new HttpError(409, "الوردية مقفولة");
    const e = await expectedCash(id);
    await app.db.query(`UPDATE shifts SET closed_at = now(), closing_cash_minor = $2, expected_cash_minor = $3 WHERE id = $1`, [id, b.closingCashMinor, e.expected]);
    const diff = b.closingCashMinor - e.expected;
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, deviceId: req.user.did, action: "shift.close", entity: "shift", entityId: id, data: { expected: e.expected, counted: b.closingCashMinor, diff } });
    return { expectedCashMinor: e.expected, closingCashMinor: b.closingCashMinor, differenceMinor: diff, salesCount: e.sales_count, salesTotalMinor: e.sales_total };
  });
}

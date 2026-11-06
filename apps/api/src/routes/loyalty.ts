import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loyaltySettingsSchema } from "@pos/shared";
import { audit, inTx } from "../db";
import { HttpError, authenticate, requireRole } from "../auth";
import { addPoints, customerPoints, loyaltySettings } from "../loyalty";

export async function loyaltyRoutes(app: FastifyInstance) {
  /** Every till needs the rules to work points out offline. */
  app.get("/loyalty/settings", { preHandler: authenticate }, async (req) => loyaltySettings(app.db, req.user.tid));

  app.put("/loyalty/settings", { preHandler: requireRole("owner") }, async (req) => {
    const b = loyaltySettingsSchema.parse(req.body);
    const before = await loyaltySettings(app.db, req.user.tid);
    await app.db.query(`UPDATE tenants SET loyalty = $2 WHERE id = $1`, [req.user.tid, b]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "loyalty.settings", data: { from: before, to: b } });
    return b;
  });

  /** A customer's points, newest first, with the invoice each came from. */
  app.get("/customers/:id/points", { preHandler: authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = (await app.db.query(`SELECT id, name FROM customers WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid])).rows[0];
    if (!c) throw new HttpError(404, "العميل غير موجود");
    const r = await app.db.query(
      `SELECT e.id, e.points, e.kind, e.note, e.created_at, s.number AS sale_number, u.name AS user_name
       FROM loyalty_entries e LEFT JOIN sales s ON s.id = e.sale_id LEFT JOIN users u ON u.id = e.user_id
       WHERE e.customer_id = $1 ORDER BY e.created_at DESC, e.id LIMIT 200`,
      [id],
    );
    return { customer: c, points: await customerPoints(app.db, id), entries: r.rows };
  });

  /** A manager adds or takes away points by hand, with a reason. */
  app.post("/customers/:id/points", { preHandler: requireRole("owner", "manager") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ points: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0), note: z.string().min(2).max(200) }).parse(req.body);
    return inTx(app.db, async (tx) => {
      const c = (await tx.query(`SELECT id FROM customers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, req.user.tid])).rows[0];
      if (!c) throw new HttpError(404, "العميل غير موجود");
      const have = await customerPoints(tx, id);
      if (have + b.points < 0) throw new HttpError(400, `العميل عنده ${have} نقطة بس`);
      await addPoints(tx, { tenantId: req.user.tid, customerId: id, points: b.points, kind: "adjust", note: b.note, userId: req.user.sub });
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "loyalty.adjust", entity: "customer", entityId: id, data: b });
      return { points: have + b.points };
    });
  });
}

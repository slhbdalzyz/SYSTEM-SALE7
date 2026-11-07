import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, inTx } from "../db";
import { authenticate, HttpError, requireRole } from "../auth";
import { ticketView } from "./platform-pro";

/** The shop's side of the platform: its announcements, support tickets, and the support-access switch. */
export async function supportRoutes(app: FastifyInstance) {
  const anyone = { preHandler: authenticate };
  const owner = { preHandler: requireRole("owner") };
  const managers = { preHandler: requireRole("owner", "manager") };

  /** Announcements meant for this shop, still running, not yet closed by this user. */
  app.get("/announcements", anyone, async (req) => {
    const r = await app.db.query(
      `SELECT n.id, n.title, n.body, n.level, n.starts_at FROM announcements n, tenants t
       WHERE t.id = $1 AND n.active AND n.starts_at <= now() AND (n.ends_at IS NULL OR n.ends_at > now())
         AND (n.plans IS NULL OR t.plan_code = ANY(n.plans)) AND (n.tenant_ids IS NULL OR t.id = ANY(n.tenant_ids))
         AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id = n.id AND d.user_id = $2)
       ORDER BY n.starts_at DESC LIMIT 5`,
      [req.user.tid, req.user.sub],
    );
    return r.rows;
  });
  app.post("/announcements/:id/dismiss", anyone, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await app.db.query(`INSERT INTO announcement_dismissals (announcement_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, req.user.sub]);
    return { ok: true };
  });

  app.get("/support/tickets", managers, async (req) => {
    const r = await app.db.query(
      `SELECT k.id, k.number, k.subject, k.status, k.created_at, k.updated_at,
              (SELECT m.author FROM support_messages m WHERE m.ticket_id = k.id ORDER BY m.created_at DESC LIMIT 1) AS last_author
       FROM support_tickets k WHERE k.tenant_id = $1 ORDER BY k.updated_at DESC LIMIT 100`,
      [req.user.tid],
    );
    return r.rows.map((x) => ({ ...x, number: Number(x.number) }));
  });
  app.post("/support/tickets", { preHandler: requireRole("owner", "manager"), config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req) => {
    const b = z.object({ subject: z.string().trim().min(3).max(150), body: z.string().trim().min(1).max(5000) }).parse(req.body);
    const open = (await app.db.query(`SELECT count(*)::int AS n FROM support_tickets WHERE tenant_id = $1 AND status <> 'closed'`, [req.user.tid])).rows[0].n;
    if (open >= 10) throw new HttpError(400, "عندك طلبات دعم مفتوحة كثير، كمّل فيها أولاً");
    const out = await inTx(app.db, async (tx) => {
      const k = (await tx.query(`INSERT INTO support_tickets (tenant_id, user_id, subject) VALUES ($1,$2,$3) RETURNING id, number`, [req.user.tid, req.user.sub, b.subject])).rows[0];
      await tx.query(`INSERT INTO support_messages (ticket_id, author, user_id, body) VALUES ($1, 'shop', $2, $3)`, [k.id, req.user.sub, b.body]);
      return { id: k.id as string, number: Number(k.number) };
    });
    return out;
  });
  app.get("/support/tickets/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = await ticketView(app.db, id, req.user.tid);
    const { tenant_name: _n, phone: _p, support_until: _s, ...rest } = t;
    return rest;
  });
  app.post("/support/tickets/:id/reply", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { body, close } = z.object({ body: z.string().trim().max(5000).default(""), close: z.boolean().default(false) }).parse(req.body);
    const k = (await app.db.query(`SELECT id FROM support_tickets WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid])).rows[0];
    if (!k) throw new HttpError(404, "غير موجود");
    if (!body && !close) throw new HttpError(400, "اكتب الرسالة");
    await inTx(app.db, async (tx) => {
      if (body) await tx.query(`INSERT INTO support_messages (ticket_id, author, user_id, body) VALUES ($1, 'shop', $2, $3)`, [id, req.user.sub, body]);
      await tx.query(`UPDATE support_tickets SET status = $2, updated_at = now() WHERE id = $1`, [id, close ? "closed" : "open"]);
    });
    return { ok: true };
  });

  /** The owner lets the platform's support team look at the shop (read only) for a few hours. */
  app.get("/support/access", owner, async (req) => {
    const t = (await app.db.query(`SELECT support_until FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    const logins = (await app.db.query(
      `SELECT created_at, data FROM audit_log WHERE tenant_id = $1 AND action = 'support.login' ORDER BY created_at DESC LIMIT 10`, [req.user.tid],
    )).rows;
    const until = t.support_until && new Date(t.support_until).getTime() > Date.now() ? t.support_until : null;
    return { until, logins };
  });
  app.post("/support/access", owner, async (req) => {
    const { hours } = z.object({ hours: z.number().int().min(0).max(72) }).parse(req.body);
    const r = await app.db.query(
      `UPDATE tenants SET support_until = CASE WHEN $2 > 0 THEN now() + make_interval(hours => $2) ELSE NULL END WHERE id = $1 RETURNING support_until`,
      [req.user.tid, hours],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: hours ? "support.allow" : "support.revoke", data: { hours } });
    return { until: r.rows[0].support_until };
  });
}

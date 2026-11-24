import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readShopSettings, type ShiftSettings } from "@pos/shared";
import { audit, inTx, type Db, type Tx } from "../db";
import { HttpError, requireDevice, requireRole, verifyApproval } from "../auth";
import { alertCashDiff, flushPushes } from "../alerts";

type Q = Db | Tx;
const TZ = "Africa/Tripoli";

/** What the drawer should hold, and what the card machine and transfers should show, for one shift. */
export async function expectedCash(db: Q, shiftId: string) {
  const r = await db.query(
      `SELECT sh.opening_cash_minor
         + COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.shift_id = sh.id AND p.method = 'cash'), 0)
         - COALESCE((SELECT sum(s.change_minor) FROM sales s WHERE s.shift_id = sh.id), 0)
         + COALESCE((SELECT sum(cp.amount_minor) FROM customer_payments cp WHERE cp.shift_id = sh.id AND cp.method = 'cash'), 0)
         + COALESCE((SELECT sum(CASE dm.kind WHEN 'in' THEN dm.amount_minor ELSE -dm.amount_minor END) FROM drawer_moves dm WHERE dm.shift_id = sh.id), 0) AS expected,
         (SELECT count(*)::int FROM sales s WHERE s.shift_id = sh.id AND s.kind = 'sale') AS sales_count,
         COALESCE((SELECT sum(s.total_minor) FROM sales s WHERE s.shift_id = sh.id), 0) AS sales_total,
         COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.shift_id = sh.id
                     AND p.method NOT IN ('cash', 'transfer', 'cheque', 'credit', 'payroll', 'points')), 0)
         + COALESCE((SELECT sum(cp.amount_minor) FROM customer_payments cp WHERE cp.shift_id = sh.id AND cp.method = 'card'), 0) AS card,
         COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.shift_id = sh.id AND p.method IN ('transfer', 'cheque')), 0)
         + COALESCE((SELECT sum(cp.amount_minor) FROM customer_payments cp WHERE cp.shift_id = sh.id AND cp.method = 'transfer'), 0) AS transfer
       FROM shifts sh WHERE sh.id = $1`,
    [shiftId],
  );
  const x = r.rows[0];
  return { expected: Number(x.expected), sales_count: Number(x.sales_count), sales_total: Number(x.sales_total), card: Number(x.card), transfer: Number(x.transfer) };
}

async function shiftSettings(db: Q, tid: string): Promise<ShiftSettings> {
  return readShopSettings((await db.query(`SELECT settings FROM tenants WHERE id = $1`, [tid])).rows[0]?.settings).shift;
}

export interface CloseInput {
  countedCashMinor: number | null;
  notes?: Record<string, number> | null;
  cardCountedMinor?: number | null;
  transferCountedMinor?: number | null;
  floatMinor?: number | null;
  reason?: string | null;
}

/**
 * Closes one shift, whoever closes it: the cashier at the till, the owner from the dashboard, or
 * the clock. A shortage goes on the cashier's pay when the owner turned that on.
 */
export async function closeShiftRow(db: Db, tid: string, shiftId: string, b: CloseInput, by: { userId: string | null; kind: "till" | "owner" | "auto"; deviceId?: string | null }) {
  return inTx(db, async (tx) => {
    const sh = (await tx.query(`SELECT id, store_id, device_id, user_id, closed_at, approved_by FROM shifts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [shiftId, tid])).rows[0];
    if (!sh) throw new HttpError(404, "الوردية غير موجودة");
    if (sh.closed_at) throw new HttpError(409, "الوردية مقفولة");
    const e = await expectedCash(tx, shiftId);
    const set = await shiftSettings(tx, tid);
    await tx.query(
      `UPDATE shifts SET closed_at = now(), closing_cash_minor = $2, expected_cash_minor = $3, counted_notes = $4, card_counted_minor = $5, card_expected_minor = $6,
              transfer_counted_minor = $7, transfer_expected_minor = $8, float_minor = $9, diff_reason = COALESCE($10, diff_reason), closed_by = $11, close_kind = $12
        WHERE id = $1`,
      [shiftId, b.countedCashMinor, e.expected, b.notes ? JSON.stringify(b.notes) : null, b.cardCountedMinor ?? null, e.card, b.transferCountedMinor ?? null, e.transfer,
        b.floatMinor ?? null, b.reason || null, by.userId, by.kind],
    );
    const diff = b.countedCashMinor === null ? null : b.countedCashMinor - e.expected;
    let deduction: string | null = null;
    if (diff !== null && diff < 0 && set.shortageToPayroll) {
      deduction = (await tx.query(
        `INSERT INTO payroll_entries (tenant_id, user_id, month, kind, amount_minor, on_date, note, created_by)
         VALUES ($1, $2, date_trunc('month', (now() AT TIME ZONE '${TZ}'))::date, 'deduction', $3, (now() AT TIME ZONE '${TZ}')::date, $4, $5) RETURNING id`,
        [tid, sh.user_id, -diff, `عجز وردية ${new Date().toISOString().slice(0, 10)}`, by.userId ?? sh.user_id],
      )).rows[0].id;
      await tx.query(`UPDATE shifts SET payroll_entry_id = $2 WHERE id = $1`, [shiftId, deduction]);
    }
    await audit(tx, {
      tenantId: tid, userId: by.userId, deviceId: by.deviceId ?? null, action: "shift.close", entity: "shift", entityId: shiftId,
      data: { expected: e.expected, counted: b.countedCashMinor, diff, by: by.kind, reason: b.reason ?? undefined, approvedBy: sh.approved_by ?? undefined, card: b.cardCountedMinor ?? undefined, float: b.floatMinor ?? undefined, deduction: deduction ?? undefined },
    });
    const names = (await tx.query(`SELECT (SELECT name FROM users WHERE id = $1) AS cashier, (SELECT name FROM devices WHERE id = $2) AS device`, [sh.user_id, sh.device_id])).rows[0];
    if (diff !== null) await alertCashDiff(tx, { tenantId: tid, storeId: sh.store_id, diffMinor: diff, cashier: names.cashier ?? "", device: names.device ?? "" });
    return { expectedCashMinor: e.expected, closingCashMinor: b.countedCashMinor, differenceMinor: diff, salesCount: e.sales_count, salesTotalMinor: e.sales_total,
      cardExpectedMinor: e.card, transferExpectedMinor: e.transfer, deducted: !!deduction };
  });
}

/**
 * Shifts still open past the shop's closing time close by themselves, with no count. Cheap
 * enough to run whenever a till or the owner looks.
 */
export async function autoCloseShifts(db: Db, tid: string, now = new Date()) {
  const set = await shiftSettings(db, tid);
  if (!set.autoCloseAt) return 0;
  // The last time the clock passed autoCloseAt in Libya, as a timestamp.
  const due = (await db.query(
    `SELECT id FROM shifts WHERE tenant_id = $1 AND closed_at IS NULL AND opened_at < (
       SELECT CASE WHEN t <= ($2::timestamptz AT TIME ZONE '${TZ}') THEN t ELSE t - interval '1 day' END AT TIME ZONE '${TZ}'
         FROM (SELECT (($2::timestamptz AT TIME ZONE '${TZ}')::date + $3::time) AS t) x)`,
    [tid, now.toISOString(), set.autoCloseAt],
  )).rows;
  for (const r of due) await closeShiftRow(db, tid, r.id, { countedCashMinor: null }, { userId: null, kind: "auto" }).catch(() => undefined);
  if (due.length) await flushPushes(db, tid);
  return due.length;
}

const closeBody = z.object({
  closingCashMinor: z.number().int().nonnegative(),
  notes: z.record(z.string().regex(/^\d+(\.\d+)?$/), z.number().int().min(0).max(100000)).nullish(),
  cardCountedMinor: z.number().int().nonnegative().nullish(),
  transferCountedMinor: z.number().int().nonnegative().nullish(),
  floatMinor: z.number().int().nonnegative().nullish(),
  reason: z.string().trim().max(300).nullish(),
});

export async function shiftRoutes(app: FastifyInstance) {

  /** Money put into or taken out of the drawer during a shift, with its reason. Sent once even if retried. */
  app.post("/shifts/drawer", { preHandler: requireDevice }, async (req) => {
    const b = z.object({
      id: z.string().uuid(), shiftId: z.string().uuid().nullish(), kind: z.enum(["in", "out"]),
      amountMinor: z.number().int().positive(), reason: z.string().trim().min(1).max(200), at: z.string().datetime().optional(),
    }).parse(req.body);
    if (b.shiftId && !(await app.db.query(`SELECT 1 FROM shifts WHERE id = $1 AND tenant_id = $2 AND device_id = $3`, [b.shiftId, req.user.tid, req.user.did])).rowCount) {
      throw new HttpError(404, "الوردية غير موجودة");
    }
    const r = await app.db.query(
      `INSERT INTO drawer_moves (id, tenant_id, store_id, device_id, shift_id, user_id, kind, amount_minor, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,LEAST(COALESCE($10::timestamptz, now()), now())) ON CONFLICT (id) DO NOTHING`,
      [b.id, req.user.tid, req.user.sid, req.user.did, b.shiftId ?? null, req.user.sub, b.kind, b.amountMinor, b.reason, b.at ?? null],
    );
    if (r.rowCount) {
      await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, deviceId: req.user.did, action: b.kind === "in" ? "drawer.in" : "drawer.out", entity: "shift", entityId: b.shiftId ?? undefined, data: { amount: b.amountMinor, reason: b.reason } });
    }
    return { id: b.id };
  });

  app.get("/shifts/current", { preHandler: requireDevice }, async (req) => {
    await autoCloseShifts(app.db, req.user.tid);
    const r = await app.db.query(
      `SELECT id, user_id, opened_at, opening_cash_minor FROM shifts WHERE tenant_id = $1 AND device_id = $2 AND closed_at IS NULL`,
      [req.user.tid, req.user.did],
    );
    if (!r.rowCount) return { shift: null };
    return { shift: { ...r.rows[0], ...(await expectedCash(app.db, r.rows[0].id)) } };
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
    const b = closeBody.parse(req.body);
    const sh = await app.db.query(`SELECT 1 FROM shifts WHERE id = $1 AND tenant_id = $2 AND device_id = $3`, [id, req.user.tid, req.user.did]);
    if (!sh.rowCount) throw new HttpError(404, "الوردية غير موجودة");
    const out = await closeShiftRow(app.db, req.user.tid, id, { ...b, countedCashMinor: b.closingCashMinor }, { userId: req.user.sub, kind: "till", deviceId: req.user.did });
    await flushPushes(app.db, req.user.tid);
    return out;
  });

  /**
   * A difference over the shop's limit: a manager (or the owner) approves it with their PIN at the
   * till before the cashier closes. Needs the till to be online.
   */
  app.post("/shifts/:id/approve", { preHandler: requireDevice, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ userId: z.string().uuid(), pin: z.string().regex(/^\d{4,8}$/), reason: z.string().trim().max(300).optional() }).parse(req.body);
    const sh = (await app.db.query(`SELECT closed_at FROM shifts WHERE id = $1 AND tenant_id = $2 AND device_id = $3`, [id, req.user.tid, req.user.did])).rows[0];
    if (!sh) throw new HttpError(404, "الوردية مش واصلة للسيرفر بعد. استنى المزامنة وعاود");
    if (sh.closed_at) throw new HttpError(409, "الوردية مقفولة");
    const approver = await verifyApproval(app.db, req.user.tid, b);
    await app.db.query(`UPDATE shifts SET approved_by = $2, diff_reason = COALESCE($3, diff_reason) WHERE id = $1`, [id, approver, b.reason || null]);
    await audit(app.db, { tenantId: req.user.tid, userId: approver, deviceId: req.user.did, action: "shift.approve", entity: "shift", entityId: id, data: { reason: b.reason } });
    return { approvedBy: approver };
  });

  /** The owner or a manager closes a shift left open, from the dashboard or the phone. */
  app.post("/shifts/:id/owner-close", { preHandler: requireRole("owner", "manager") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ countedCashMinor: z.number().int().nonnegative().nullable().default(null), reason: z.string().trim().max(300).nullish() }).parse(req.body ?? {});
    const out = await closeShiftRow(app.db, req.user.tid, id, { countedCashMinor: b.countedCashMinor, reason: b.reason ?? "قفلها المالك" }, { userId: req.user.sub, kind: "owner" });
    await flushPushes(app.db, req.user.tid);
    return out;
  });
}

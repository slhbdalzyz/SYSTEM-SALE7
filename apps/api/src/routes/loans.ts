import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { effectivePermissions, formatMoney, loanSettingsSchema, readShopSettings, type LoanSettings } from "@pos/shared";
import { audit, inTx, type Db, type Tx } from "../db";
import { HttpError, authenticate, requirePerm, verifyApproval } from "../auth";
import { flushPushes, raiseAlert } from "../alerts";

/**
 * Cash lent from the drawer (سلفة: the person brings it back) and money a person leaves with the
 * shop (أمانة: they take it back later). Each one is kept under the person's name with every
 * payment back or withdrawal, so nobody has to remember who took what. A move at a till goes
 * through the drawer like any cash in or out, so the shift counts it; one recorded from the
 * owner's page goes into the treasury's cash on its own.
 */

type Q = Db | Tx;
const TZ = "Africa/Tripoli";
const today = `(now() AT TIME ZONE '${TZ}')::date`;
export type LoanKind = "loan" | "deposit";
export const LOAN_WORD: Record<LoanKind, string> = { loan: "سلفة", deposit: "أمانة" };

const money = z.number().int().positive().max(1e12);
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

async function loanSettings(q: Q, tid: string): Promise<LoanSettings> {
  return readShopSettings((await q.query(`SELECT settings FROM tenants WHERE id = $1`, [tid])).rows[0]?.settings).loans;
}

/** Who may see and record loans away from a till: the owner, a manager, or staff with the money permission. */
async function staffOrTill(req: FastifyRequest) {
  await authenticate(req);
  if (req.user.did || req.user.role === "owner") return;
  const u = (await req.server.db.query(`SELECT role, permissions FROM users WHERE id = $1 AND tenant_id = $2 AND active`, [req.user.sub, req.user.tid])).rows[0];
  if (!u) throw new HttpError(401, "الحساب موقوف");
  const mine = effectivePermissions(u.role, u.permissions);
  if (u.role !== "manager" && !mine.includes("money") && !mine.includes("customers")) throw new HttpError(403, "ليس لديك صلاحية");
}

/** One loan with what is still out: for a loan, what the person still owes; for a deposit, what the shop still holds. */
const LOAN_SELECT = `
  SELECT l.id, l.kind, l.person_name AS "personName", l.phone, l.customer_id AS "customerId", l.amount_minor::bigint AS "amountMinor",
         to_char(l.due_on, 'YYYY-MM-DD') AS "dueOn", l.note, l.status, l.store_id AS "storeId", st.name AS "storeName",
         cu.name AS "createdByName", ap.name AS "approvedByName", l.created_at AS "createdAt", l.closed_at AS "closedAt",
         COALESCE((SELECT sum(m.amount_minor) FROM loan_moves m WHERE m.loan_id = l.id AND m.kind = 'open'), 0)::bigint AS "openedMinor",
         COALESCE((SELECT sum(m.amount_minor) FROM loan_moves m WHERE m.loan_id = l.id AND m.kind = 'back'), 0)::bigint AS "backMinor",
         (SELECT max(m.created_at) FROM loan_moves m WHERE m.loan_id = l.id) AS "lastMoveAt"
    FROM loans l LEFT JOIN stores st ON st.id = l.store_id LEFT JOIN users cu ON cu.id = l.created_by LEFT JOIN users ap ON ap.id = l.approved_by`;

interface LoanRow {
  id: string; kind: LoanKind; personName: string; phone: string | null; customerId: string | null; amountMinor: number; dueOn: string | null;
  note: string | null; status: string; storeId: string | null; storeName: string | null; createdByName: string | null; approvedByName: string | null;
  createdAt: string; closedAt: string | null; openedMinor: number; backMinor: number; lastMoveAt: string | null;
}

function shape(r: Record<string, unknown>, day: string) {
  const x = { ...r, amountMinor: Number(r.amountMinor), openedMinor: Number(r.openedMinor), backMinor: Number(r.backMinor) } as LoanRow;
  const leftMinor = x.status === "open" ? Math.max(0, x.openedMinor - x.backMinor) : 0;
  return { ...x, leftMinor, overdue: x.kind === "loan" && x.status === "open" && !!x.dueOn && x.dueOn < day && leftMinor > 0 };
}
export type Loan = ReturnType<typeof shape>;

async function todayIs(q: Q): Promise<string> {
  return (await q.query(`SELECT to_char(${today}, 'YYYY-MM-DD') AS d`)).rows[0].d;
}

export async function getLoan(q: Q, tid: string, id: string): Promise<Loan | null> {
  const r = (await q.query(`${LOAN_SELECT} WHERE l.tenant_id = $1 AND l.id = $2`, [tid, id])).rows[0];
  return r ? shape(r, await todayIs(q)) : null;
}

/** The customer with this phone, when the shop has one, so the loan shows on their card. */
async function customerByPhone(q: Q, tid: string, phone: string | null | undefined): Promise<string | null> {
  const digits = (phone ?? "").replace(/\D/g, "").replace(/^(00)?218/, "0");
  if (digits.length < 7) return null;
  return (await q.query(
    `SELECT id FROM customers WHERE tenant_id = $1 AND regexp_replace(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), '^(00)?218', '0') = $2 LIMIT 1`,
    [tid, digits],
  )).rows[0]?.id ?? null;
}

/**
 * One move of money on a loan. At a till it goes through the drawer (out for a loan or a
 * withdrawal, in for a deposit or a payment back); elsewhere it stands alone and the treasury
 * counts it as cash.
 */
async function addMove(tx: Tx, o: {
  tid: string; loan: { id: string; kind: LoanKind; personName: string }; moveId: string; kind: "open" | "back"; amountMinor: number;
  at?: string | null; note?: string | null; till: { storeId: string; deviceId: string; shiftId: string | null; userId: string } | null; userId: string;
}) {
  let drawerId: string | null = null;
  if (o.till) {
    const out = (o.loan.kind === "loan") === (o.kind === "open");
    drawerId = (await tx.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    const what = o.kind === "open" ? LOAN_WORD[o.loan.kind] : o.loan.kind === "loan" ? "رجوع سلفة" : "رفع أمانة";
    await tx.query(
      `INSERT INTO drawer_moves (id, tenant_id, store_id, device_id, shift_id, user_id, kind, amount_minor, reason, created_at, loan_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,LEAST(COALESCE($10::timestamptz, now()), now()),$11)`,
      [drawerId, o.tid, o.till.storeId, o.till.deviceId, o.till.shiftId, o.till.userId, out ? "out" : "in", o.amountMinor, `${what}: ${o.loan.personName}`, o.at ?? null, o.loan.id],
    );
  }
  await tx.query(
    `INSERT INTO loan_moves (id, tenant_id, loan_id, kind, amount_minor, device_id, shift_id, user_id, drawer_move_id, note, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,LEAST(COALESCE($11::timestamptz, now()), now()))`,
    [o.moveId, o.tid, o.loan.id, o.kind, o.amountMinor, o.till?.deviceId ?? null, o.till?.shiftId ?? null, o.userId, drawerId, o.note ?? null, o.at ?? null],
  );
}

/** The till's shift, checked to be this device's and still open. */
async function tillOf(q: Q, req: FastifyRequest, shiftId: string | null | undefined) {
  if (!req.user.did || !req.user.sid) return null;
  if (shiftId && !(await q.query(`SELECT 1 FROM shifts WHERE id = $1 AND tenant_id = $2 AND device_id = $3`, [shiftId, req.user.tid, req.user.did])).rowCount) {
    throw new HttpError(404, "الوردية غير موجودة");
  }
  return { storeId: req.user.sid, deviceId: req.user.did, shiftId: shiftId ?? null, userId: req.user.sub };
}

/**
 * Loans whose day came and that are not back: one alert each, once, so the owner's phone hears of
 * it and the reminder is a tap away.
 */
export async function checkDueLoans(q: Q, tenantId: string) {
  if (!(await loanSettings(q, tenantId)).alertOverdue) return 0;
  const r = await q.query(
    `${LOAN_SELECT} WHERE l.tenant_id = $1 AND l.kind = 'loan' AND l.status = 'open' AND l.due_on IS NOT NULL AND l.due_on <= ${today}
       AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.tenant_id = $1 AND a.kind = 'loan_due' AND a.data->>'loanId' = l.id::text)`,
    [tenantId],
  );
  const day = await todayIs(q);
  let n = 0;
  for (const row of r.rows) {
    const l = shape(row, day);
    if (l.leftMinor <= 0) continue;
    await raiseAlert(q, {
      tenantId, storeId: l.storeId, kind: "loan_due", title: `سلفة ${l.personName} ${l.dueOn === day ? "موعدها اليوم" : "فات موعدها"}`,
      body: `باقي عليه ${formatMoney(l.leftMinor)} من ${formatMoney(l.openedMinor)}. ذكّره من «🤝 السلف والأمانات».`, data: { loanId: l.id },
    });
    n++;
  }
  return n;
}

const newLoan = z.object({
  id: z.string().uuid(),
  kind: z.enum(["loan", "deposit"]),
  personName: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(30).nullish(),
  customerId: z.string().uuid().nullish(),
  amountMinor: money,
  dueOn: z.string().regex(dateRe).nullish(),
  note: z.string().trim().max(200).nullish(),
  shiftId: z.string().uuid().nullish(),
  at: z.string().datetime().nullish(),
  /** A manager's PIN at the till, for a loan over the cashier's limit. */
  approval: z.object({ userId: z.string().uuid(), pin: z.string().min(1).max(20) }).optional(),
  /** Over the limit with no PIN: send it to the owner's phone and wait. */
  ask: z.boolean().optional(),
});

export async function loanRoutes(app: FastifyInstance) {
  /** The shop's loan rules («🤝 السلف والأمانات» in ⚙ الإعدادات). */
  app.patch("/settings/loans", { preHandler: requirePerm("settings") }, async (req) => {
    const b = loanSettingsSchema.parse(req.body);
    const t = (await app.db.query(`SELECT settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    const s = readShopSettings(t?.settings);
    s.loans = b;
    await app.db.query(`UPDATE tenants SET settings = $2 WHERE id = $1`, [req.user.tid, JSON.stringify(s)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: { loans: b } });
    return { loans: s.loans };
  });

  /**
   * A new loan or deposit. At a till, a cashier lending over the shop's limit needs a manager's
   * PIN, or asks the owner and waits (status «pending»). Sent once even if retried.
   */
  app.post("/loans", { preHandler: staffOrTill }, async (req) => {
    const b = newLoan.parse(req.body);
    const tid = req.user.tid;
    const done = await getLoan(app.db, tid, b.id);
    if (done) return done;
    const set = await loanSettings(app.db, tid);
    const boss = ["owner", "manager"].includes(req.user.role);
    let approvedBy: string | null = boss ? req.user.sub : null;
    let pending = false;
    if (b.kind === "loan" && !boss && set.cashierLimitMinor > 0 && b.amountMinor > set.cashierLimitMinor) {
      if (b.approval) approvedBy = await verifyApproval(app.db, tid, b.approval);
      else if (b.ask) pending = true;
      else throw new HttpError(403, `السلفة فوق ${formatMoney(set.cashierLimitMinor)} تحتاج موافقة المدير أو صاحب المحل`);
    }
    const customerId = b.customerId
      ? (await app.db.query(`SELECT id FROM customers WHERE id = $1 AND tenant_id = $2`, [b.customerId, tid])).rows[0]?.id ?? null
      : await customerByPhone(app.db, tid, b.phone);
    const loan = await inTx(app.db, async (tx) => {
      const till = await tillOf(tx, req, b.shiftId);
      await tx.query(
        `INSERT INTO loans (id, tenant_id, store_id, kind, person_name, phone, customer_id, amount_minor, due_on, note, status, created_by, approved_by, device_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,LEAST(COALESCE($15::timestamptz, now()), now()))`,
        [b.id, tid, till?.storeId ?? null, b.kind, b.personName, b.phone || null, customerId, b.amountMinor, b.dueOn ?? null, b.note || null,
          pending ? "pending" : "open", req.user.sub, approvedBy, till?.deviceId ?? null, b.at ?? null],
      );
      if (!pending) {
        await addMove(tx, { tid, loan: { id: b.id, kind: b.kind, personName: b.personName }, moveId: b.id, kind: "open", amountMinor: b.amountMinor, at: b.at, till, userId: req.user.sub });
      } else {
        const who = (await tx.query(`SELECT name FROM users WHERE id = $1`, [req.user.sub])).rows[0]?.name ?? "الكاشير";
        await raiseAlert(tx, {
          tenantId: tid, storeId: till?.storeId, kind: "loan_request", title: `${who} يبي يسلّف ${formatMoney(b.amountMinor)}`,
          body: `سلفة لـ ${b.personName}، فوق الحد (${formatMoney(set.cashierLimitMinor)}). وافق أو ارفض من «🤝 السلف والأمانات».`, data: { loanId: b.id },
        });
      }
      await audit(tx, {
        tenantId: tid, userId: req.user.sub, deviceId: req.user.did, action: pending ? "loan.request" : `${b.kind}.open`, entity: "loan", entityId: b.id,
        data: { person: b.personName, amount: b.amountMinor, due: b.dueOn, approvedBy },
      });
      return getLoan(tx, tid, b.id);
    });
    if (pending) void flushPushes(app.db, tid);
    return loan;
  });

  /** One loan, with each move: the till asks this while it waits for the owner's answer. */
  /** The report for a stretch of days: lent, back, deposits in and out, and how fast loans come back. */
  app.get("/loans/report", { preHandler: staffOrTill }, async (req) => {
    const q = z.object({ from: z.string().regex(dateRe), to: z.string().regex(dateRe) }).parse(req.query);
    const r = (await app.db.query(
      `SELECT l.kind, m.kind AS move, count(*)::int AS n, COALESCE(sum(m.amount_minor), 0)::bigint AS amount
         FROM loan_moves m JOIN loans l ON l.id = m.loan_id
        WHERE m.tenant_id = $1 AND (m.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date
        GROUP BY l.kind, m.kind`,
      [req.user.tid, q.from, q.to],
    )).rows;
    const pick = (kind: LoanKind, move: "open" | "back") => {
      const x = r.find((y) => y.kind === kind && y.move === move);
      return { count: x?.n ?? 0, amountMinor: Number(x?.amount ?? 0) };
    };
    const speed = (await app.db.query(
      `SELECT avg(EXTRACT(EPOCH FROM (l.closed_at - l.created_at)) / 86400)::float AS days, count(*)::int AS n,
              count(*) FILTER (WHERE l.due_on IS NOT NULL AND (l.closed_at AT TIME ZONE '${TZ}')::date <= l.due_on)::int AS on_time
         FROM loans l WHERE l.tenant_id = $1 AND l.kind = 'loan' AND l.status = 'closed' AND (l.closed_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date`,
      [req.user.tid, q.from, q.to],
    )).rows[0];
    const byDay = (await app.db.query(
      `SELECT to_char((m.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day,
              COALESCE(sum(m.amount_minor) FILTER (WHERE l.kind = 'loan' AND m.kind = 'open'), 0)::bigint AS lent,
              COALESCE(sum(m.amount_minor) FILTER (WHERE l.kind = 'loan' AND m.kind = 'back'), 0)::bigint AS back
         FROM loan_moves m JOIN loans l ON l.id = m.loan_id
        WHERE m.tenant_id = $1 AND (m.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY 1`,
      [req.user.tid, q.from, q.to],
    )).rows.map((x) => ({ day: x.day, lentMinor: Number(x.lent), backMinor: Number(x.back) }));
    return {
      lent: pick("loan", "open"), back: pick("loan", "back"), depositsIn: pick("deposit", "open"), depositsOut: pick("deposit", "back"),
      closed: speed.n, onTime: speed.on_time, avgDays: speed.days === null ? null : Math.round(speed.days * 10) / 10, byDay,
    };
  });

  app.get("/loans/:id", { preHandler: staffOrTill }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const l = await getLoan(app.db, req.user.tid, id);
    if (!l) throw new HttpError(404, "السلفة غير موجودة");
    const moves = (await app.db.query(
      `SELECT m.id, m.kind, m.amount_minor::bigint AS "amountMinor", m.note, m.created_at AS "at", u.name AS "userName", d.name AS "deviceName", (m.drawer_move_id IS NOT NULL) AS "drawer"
         FROM loan_moves m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN devices d ON d.id = m.device_id WHERE m.loan_id = $1 ORDER BY m.created_at`,
      [id],
    )).rows.map((m) => ({ ...m, amountMinor: Number(m.amountMinor) }));
    return { ...l, moves };
  });

  /** The owner (or a manager) answers a cashier asking to lend over the limit. */
  app.post("/loans/:id/decide", { preHandler: requirePerm("money") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    if (!["owner", "manager"].includes(req.user.role)) throw new HttpError(403, "الموافقة لصاحب المحل أو المدير");
    const r = await app.db.query(
      `UPDATE loans SET status = $3, approved_by = $4 WHERE id = $1 AND tenant_id = $2 AND status = 'pending' RETURNING id`,
      [id, req.user.tid, approve ? "approved" : "rejected", req.user.sub],
    );
    if (!r.rowCount) throw new HttpError(409, "الطلب هذا اتجاوب عليه قبل");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: approve ? "loan.approve" : "loan.reject", entity: "loan", entityId: id });
    return getLoan(app.db, req.user.tid, id);
  });

  /** The owner said yes: the till hands the money over now, out of its drawer. */
  app.post("/loans/:id/pay", { preHandler: staffOrTill }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ shiftId: z.string().uuid().nullish(), at: z.string().datetime().nullish() }).parse(req.body ?? {});
    const tid = req.user.tid;
    return inTx(app.db, async (tx) => {
      const l = (await tx.query(`SELECT id, kind, person_name, amount_minor, status FROM loans WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, tid])).rows[0];
      if (!l) throw new HttpError(404, "السلفة غير موجودة");
      if (l.status === "open" || l.status === "closed") return getLoan(tx, tid, id);
      if (l.status !== "approved") throw new HttpError(409, l.status === "rejected" ? "صاحب المحل رفض السلفة" : "السلفة مازالت تستنى الموافقة");
      const till = await tillOf(tx, req, b.shiftId);
      await addMove(tx, { tid, loan: { id, kind: l.kind, personName: l.person_name }, moveId: id, kind: "open", amountMinor: Number(l.amount_minor), at: b.at, till, userId: req.user.sub });
      await tx.query(`UPDATE loans SET status = 'open', created_at = now() WHERE id = $1`, [id]);
      await audit(tx, { tenantId: tid, userId: req.user.sub, deviceId: req.user.did, action: "loan.open", entity: "loan", entityId: id, data: { amount: Number(l.amount_minor) } });
      return getLoan(tx, tid, id);
    });
  });

  /**
   * Money back on a loan, or taken out of a deposit: all of it or a part, at any till or branch,
   * or from the owner's page. Closes it once nothing is left. Sent once even if retried.
   */
  app.post("/loans/:id/moves", { preHandler: staffOrTill }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      id: z.string().uuid(), amountMinor: money, shiftId: z.string().uuid().nullish(), at: z.string().datetime().nullish(), note: z.string().trim().max(200).nullish(),
    }).parse(req.body);
    const tid = req.user.tid;
    return inTx(app.db, async (tx) => {
      if ((await tx.query(`SELECT 1 FROM loan_moves WHERE id = $1 AND tenant_id = $2`, [b.id, tid])).rowCount) return getLoan(tx, tid, id);
      const row = (await tx.query(`SELECT id, kind, person_name, status FROM loans WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, tid])).rows[0];
      if (!row) throw new HttpError(404, "السلفة غير موجودة");
      if (row.status !== "open") throw new HttpError(409, row.status === "closed" ? "هذي خلصت قبل" : "هذي مش مفتوحة");
      const l = (await getLoan(tx, tid, id))!;
      if (b.amountMinor > l.leftMinor) throw new HttpError(400, `المبلغ أكبر من الباقي (${formatMoney(l.leftMinor)})`);
      const till = await tillOf(tx, req, b.shiftId);
      await addMove(tx, { tid, loan: { id, kind: row.kind, personName: row.person_name }, moveId: b.id, kind: "back", amountMinor: b.amountMinor, at: b.at, note: b.note, till, userId: req.user.sub });
      if (b.amountMinor === l.leftMinor) await tx.query(`UPDATE loans SET status = 'closed', closed_at = now() WHERE id = $1`, [id]);
      await audit(tx, { tenantId: tid, userId: req.user.sub, deviceId: req.user.did, action: `${row.kind}.back`, entity: "loan", entityId: id, data: { amount: b.amountMinor, left: l.leftMinor - b.amountMinor } });
      return getLoan(tx, tid, id);
    });
  });

  /** Changes the day it's due, the phone or the note. */
  app.patch("/loans/:id", { preHandler: requirePerm("money") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ dueOn: z.string().regex(dateRe).nullish(), phone: z.string().trim().max(30).nullish(), note: z.string().trim().max(200).nullish() }).parse(req.body);
    const r = await app.db.query(
      `UPDATE loans SET due_on = CASE WHEN $3 THEN $4::date ELSE due_on END, phone = CASE WHEN $5 THEN $6 ELSE phone END, note = CASE WHEN $7 THEN $8 ELSE note END
        WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, req.user.tid, b.dueOn !== undefined, b.dueOn ?? null, b.phone !== undefined, b.phone || null, b.note !== undefined, b.note || null],
    );
    if (!r.rowCount) throw new HttpError(404, "السلفة غير موجودة");
    // A new day: the owner hears again when that one comes.
    if (b.dueOn !== undefined) await app.db.query(`DELETE FROM alerts WHERE tenant_id = $1 AND kind = 'loan_due' AND data->>'loanId' = $2`, [req.user.tid, id]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "loan.update", entity: "loan", entityId: id, data: b });
    return getLoan(app.db, req.user.tid, id);
  });

  /**
   * The list: what is out now (or everything), with each person's total, and the totals the page
   * opens with: lent and not back, held for people, overdue, waiting for an answer.
   */
  app.get("/loans", { preHandler: staffOrTill }, async (req) => {
    const q = z.object({
      status: z.enum(["open", "closed", "all", "pending"]).default("open"),
      kind: z.enum(["loan", "deposit"]).optional(),
      q: z.string().trim().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    const tid = req.user.tid;
    if (!req.user.did) await checkDueLoans(app.db, tid).catch(() => 0);
    const where = q.status === "open" ? `l.status IN ('open', 'approved', 'pending')` : q.status === "pending" ? `l.status IN ('pending', 'approved')` : q.status === "closed" ? `l.status IN ('closed', 'rejected')` : `TRUE`;
    const r = await app.db.query(
      `${LOAN_SELECT} WHERE l.tenant_id = $1 AND ${where} AND ($2::text IS NULL OR l.kind = $2)
         AND ($3::text IS NULL OR l.person_name ILIKE '%' || $3 || '%' OR l.phone LIKE '%' || $3 || '%')
       ORDER BY (l.status = 'pending') DESC, COALESCE(l.status = 'open' AND l.kind = 'loan' AND l.due_on < ${today}, false) DESC, l.created_at DESC LIMIT $4`,
      [tid, q.kind ?? null, q.q || null, q.limit],
    );
    const day = await todayIs(app.db);
    const rows = r.rows.map((x) => shape(x, day));
    const t = (await app.db.query(
      `${LOAN_SELECT} WHERE l.tenant_id = $1 AND l.status IN ('open', 'pending', 'approved')`,
      [tid],
    )).rows.map((x) => shape(x, day));
    // Each person once: what they owe the shop and what the shop holds for them.
    const people = new Map<string, { name: string; phone: string | null; oweMinor: number; heldMinor: number; count: number; overdue: boolean }>();
    for (const l of t.filter((x) => x.status === "open")) {
      const k = (l.phone ?? "").replace(/\D/g, "") || l.personName.trim();
      const p = people.get(k) ?? { name: l.personName, phone: l.phone, oweMinor: 0, heldMinor: 0, count: 0, overdue: false };
      if (l.kind === "loan") p.oweMinor += l.leftMinor;
      else p.heldMinor += l.leftMinor;
      p.count++;
      p.overdue ||= l.overdue;
      people.set(k, p);
    }
    return {
      rows,
      people: [...people.values()].sort((a, b) => b.oweMinor + b.heldMinor - (a.oweMinor + a.heldMinor)),
      totals: {
        lentMinor: t.filter((x) => x.kind === "loan" && x.status === "open").reduce((a, x) => a + x.leftMinor, 0),
        heldMinor: t.filter((x) => x.kind === "deposit" && x.status === "open").reduce((a, x) => a + x.leftMinor, 0),
        overdue: t.filter((x) => x.overdue).length,
        overdueMinor: t.filter((x) => x.overdue).reduce((a, x) => a + x.leftMinor, 0),
        pending: t.filter((x) => x.status === "pending").length,
      },
    };
  });
}

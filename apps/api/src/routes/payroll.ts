import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PAYROLL_KINDS, dayRate, lateAmount, type PayrollKind } from "@pos/shared";
import { audit, inTx, type Tx } from "../db";
import { HttpError, authenticate, requireDevice, requirePerm } from "../auth";

/**
 * Salaries. Each member of staff has a monthly salary; the month's sheet is that salary plus
 * bonuses, minus what they bought from the shop, advances, lateness, absence, unpaid leave and
 * penalties. What is handed over is recorded as "payment"; what is left is the rest.
 *
 * Money that leaves the shop because of pay (a salary payment, an advance, goods taken on the
 * salary) is also written to the expenses, so the profit report counts staff as a cost.
 */

const TZ = "Africa/Tripoli";
const monthRe = /^\d{4}-\d{2}$/;
type Q = Pick<Tx, "query">;

const EXPENSE_CATEGORY: Partial<Record<PayrollKind, string>> = {
  payment: "رواتب",
  advance: "سلف الموظفين",
  purchase: "رواتب - مشتريات الموظفين",
};

const ADD: PayrollKind[] = ["bonus", "return"];
const SUB: PayrollKind[] = ["purchase", "advance", "late", "absence", "unpaid_leave", "deduction"];

/** 'YYYY-MM' (or now, in the shop's time) as the first day of that month. */
async function monthStart(db: Q, month?: string): Promise<string> {
  if (month) return `${month}-01`;
  return (await db.query(`SELECT to_char(date_trunc('month', now() AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS m`, [])).rows[0].m as string;
}

/** The salary a month is worked out on: fixed the first time anything is written for it. */
async function ensureMonth(db: Q, tid: string, userId: string, month: string) {
  await db.query(
    `INSERT INTO payroll_months (tenant_id, user_id, month, salary_minor)
     SELECT tenant_id, id, $3::date, salary_minor FROM users WHERE id = $1 AND tenant_id = $2
     ON CONFLICT (user_id, month) DO NOTHING`,
    [userId, tid, month],
  );
}

export interface Sheet {
  user: { id: string; name: string; role: string; job_title: string | null; salary_minor: number; day_minutes: number; hired_on: string | null; active: boolean };
  month: string;
  salaryMinor: number;
  byKind: Partial<Record<PayrollKind, number>>;
  additionsMinor: number;
  deductionsMinor: number;
  netMinor: number;
  paidMinor: number;
  remainingMinor: number;
  /** What the employee has had so far this month: goods (after returns), advances and payments. */
  takenMinor: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  absenceDays: number;
  lateMinutes: number;
}

function summarize(user: Sheet["user"], month: string, salary: number, rows: { kind: PayrollKind; amount_minor: number; days: number | null; minutes: number | null }[]): Sheet {
  const byKind: Partial<Record<PayrollKind, number>> = {};
  let paidLeaveDays = 0, unpaidLeaveDays = 0, absenceDays = 0, lateMinutes = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + Number(r.amount_minor);
    if (r.kind === "paid_leave") paidLeaveDays += r.days ?? 0;
    if (r.kind === "unpaid_leave") unpaidLeaveDays += r.days ?? 0;
    if (r.kind === "absence") absenceDays += r.days ?? 0;
    if (r.kind === "late") lateMinutes += r.minutes ?? 0;
  }
  const sum = (ks: PayrollKind[]) => ks.reduce((a, k) => a + (byKind[k] ?? 0), 0);
  const additionsMinor = sum(ADD);
  const deductionsMinor = sum(SUB);
  const netMinor = salary + additionsMinor - deductionsMinor;
  const paidMinor = byKind.payment ?? 0;
  return {
    user, month, salaryMinor: salary, byKind, additionsMinor, deductionsMinor, netMinor, paidMinor,
    remainingMinor: netMinor - paidMinor,
    takenMinor: (byKind.purchase ?? 0) - (byKind.return ?? 0) + (byKind.advance ?? 0) + paidMinor,
    paidLeaveDays, unpaidLeaveDays, absenceDays, lateMinutes,
  };
}

const USER_COLS = `u.id, u.name, u.role, u.job_title, u.salary_minor, u.day_minutes, to_char(u.hired_on, 'YYYY-MM-DD') AS hired_on, u.active`;

/** One employee's sheet for a month, with every line on it. */
export async function sheet(db: Q, tid: string, userId: string, month: string) {
  const user = (await db.query(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1 AND u.tenant_id = $2`, [userId, tid])).rows[0];
  if (!user) throw new HttpError(404, "الموظف غير موجود");
  const fixed = (await db.query(`SELECT salary_minor FROM payroll_months WHERE user_id = $1 AND month = $2`, [userId, month])).rows[0];
  const entries = (await db.query(
    `SELECT e.id, e.kind, e.amount_minor, e.days, e.minutes, to_char(e.on_date, 'YYYY-MM-DD') AS on_date, e.note, e.created_at,
            s.number AS sale_number, b.name AS created_by
     FROM payroll_entries e LEFT JOIN sales s ON s.id = e.sale_id LEFT JOIN users b ON b.id = e.created_by
     WHERE e.tenant_id = $1 AND e.user_id = $2 AND e.month = $3 ORDER BY e.on_date DESC, e.created_at DESC`,
    [tid, userId, month],
  )).rows;
  return { ...summarize(user, month.slice(0, 7), Number(fixed?.salary_minor ?? user.salary_minor), entries), entries };
}

export async function payrollRoutes(app: FastifyInstance) {
  const payroll = { preHandler: requirePerm("payroll") };

  /** Everyone's sheet for a month, for the owner or the accountant. */
  app.get("/payroll", payroll, async (req) => {
    const q = z.object({ month: z.string().regex(monthRe).optional() }).parse(req.query);
    const month = await monthStart(app.db, q.month);
    const users = (await app.db.query(
      `SELECT ${USER_COLS} FROM users u WHERE u.tenant_id = $1
         AND (u.active OR EXISTS (SELECT 1 FROM payroll_entries e WHERE e.user_id = u.id AND e.month = $2))
       ORDER BY u.active DESC, u.name`,
      [req.user.tid, month],
    )).rows;
    const fixed = new Map((await app.db.query(`SELECT user_id, salary_minor FROM payroll_months WHERE tenant_id = $1 AND month = $2`, [req.user.tid, month])).rows.map((r) => [r.user_id as string, Number(r.salary_minor)]));
    const rows = (await app.db.query(`SELECT user_id, kind, amount_minor, days, minutes FROM payroll_entries WHERE tenant_id = $1 AND month = $2`, [req.user.tid, month])).rows;
    const sheets = users.map((u) => summarize(u, month.slice(0, 7), fixed.get(u.id) ?? Number(u.salary_minor), rows.filter((r) => r.user_id === u.id)));
    const total = (k: keyof Sheet) => sheets.reduce((a, s) => a + (s[k] as number), 0);
    return {
      month: month.slice(0, 7),
      sheets,
      totals: { salaryMinor: total("salaryMinor"), netMinor: total("netMinor"), paidMinor: total("paidMinor"), remainingMinor: total("remainingMinor"), deductionsMinor: total("deductionsMinor"), additionsMinor: total("additionsMinor") },
    };
  });

  /** The till's list of staff a bill can be put on. */
  app.get("/payroll/employees", { preHandler: requireDevice }, async (req) => {
    const r = await app.db.query(`SELECT id, name FROM users WHERE tenant_id = $1 AND active ORDER BY name`, [req.user.tid]);
    return r.rows;
  });

  app.get("/payroll/:userId", payroll, async (req) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const q = z.object({ month: z.string().regex(monthRe).optional() }).parse(req.query);
    return sheet(app.db, req.user.tid, userId, await monthStart(app.db, q.month));
  });

  /**
   * A line on a sheet. Lateness, absence and unpaid leave are priced from the salary when no
   * amount is given; a payment or an advance can come out of a branch's cash as an expense.
   */
  app.post("/payroll/entries", payroll, async (req) => {
    const b = z.object({
      userId: z.string().uuid(),
      month: z.string().regex(monthRe).optional(),
      kind: z.enum(Object.keys(PAYROLL_KINDS).filter((k) => k !== "purchase" && k !== "return") as [PayrollKind, ...PayrollKind[]]),
      amountMinor: z.number().int().min(0).optional(),
      days: z.number().int().min(1).max(31).optional(),
      minutes: z.number().int().min(1).max(1440 * 31).optional(),
      onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(300).optional(),
      storeId: z.string().uuid().optional(),
      /** How a payment or an advance was handed over. */
      method: z.enum(["cash", "card", "transfer"]).default("cash"),
    }).parse(req.body);
    const tid = req.user.tid;
    const month = await monthStart(app.db, b.month);
    const id = await inTx(app.db, async (tx) => {
      const u = (await tx.query(`SELECT name, salary_minor, day_minutes FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [b.userId, tid])).rows[0];
      if (!u) throw new HttpError(404, "الموظف غير موجود");
      await ensureMonth(tx, tid, b.userId, month);
      const salary = Number((await tx.query(`SELECT salary_minor FROM payroll_months WHERE user_id = $1 AND month = $2`, [b.userId, month])).rows[0].salary_minor);

      let amount = b.amountMinor;
      if (b.kind === "late") {
        if (!b.minutes) throw new HttpError(400, "اكتب دقائق التأخير");
        amount ??= lateAmount(salary, b.minutes, u.day_minutes);
      } else if (b.kind === "absence" || b.kind === "unpaid_leave") {
        if (!b.days) throw new HttpError(400, "اكتب عدد الأيام");
        amount ??= dayRate(salary) * b.days;
      } else if (b.kind === "paid_leave") {
        if (!b.days) throw new HttpError(400, "اكتب عدد الأيام");
        amount = 0;
      } else if (!amount) {
        throw new HttpError(400, "اكتب المبلغ");
      }
      if (b.kind === "payment" || b.kind === "advance") {
        const s = await sheet(tx, tid, b.userId, month);
        if (amount > s.remainingMinor) throw new HttpError(400, `المبلغ أكبر من المتبقي من الراتب (${s.remainingMinor / 1000} د.ل)`);
      }

      let expenseId: string | null = null;
      const category = EXPENSE_CATEGORY[b.kind];
      if (category && b.storeId) {
        const st = await tx.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, tid]);
        if (!st.rowCount) throw new HttpError(404, "الفرع غير موجود");
        expenseId = (await tx.query(
          `INSERT INTO expenses (tenant_id, store_id, category, amount_minor, note, spent_on, user_id, payment_method)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, (now() AT TIME ZONE '${TZ}')::date),$7,$8) RETURNING id`,
          [tid, b.storeId, category, amount, `${u.name} — ${month.slice(0, 7)}${b.note ? ` — ${b.note}` : ""}`, b.onDate ?? null, req.user.sub, b.method],
        )).rows[0].id;
      }
      const r = await tx.query(
        `INSERT INTO payroll_entries (tenant_id, user_id, month, kind, amount_minor, days, minutes, on_date, note, expense_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, (now() AT TIME ZONE '${TZ}')::date),$9,$10,$11) RETURNING id`,
        [tid, b.userId, month, b.kind, amount, b.days ?? null, b.minutes ?? null, b.onDate ?? null, b.note ?? null, expenseId, req.user.sub],
      );
      await audit(tx, { tenantId: tid, userId: req.user.sub, action: `payroll.${b.kind}`, entity: "user", entityId: b.userId, data: { month: month.slice(0, 7), amount, days: b.days, minutes: b.minutes, note: b.note } });
      return r.rows[0].id as string;
    });
    return { id };
  });

  /** Removes a line entered by mistake. What came from a till sale is undone by a return instead. */
  app.post("/payroll/entries/:id/delete", payroll, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await inTx(app.db, async (tx) => {
      const e = (await tx.query(`DELETE FROM payroll_entries WHERE id = $1 AND tenant_id = $2 AND sale_id IS NULL RETURNING user_id, kind, amount_minor, month, expense_id`, [id, req.user.tid])).rows[0];
      if (!e) throw new HttpError(404, "البند غير موجود، أو جاي من فاتورة (يتلغى بمرتجع)");
      if (e.expense_id) await tx.query(`DELETE FROM expenses WHERE id = $1 AND tenant_id = $2`, [e.expense_id, req.user.tid]);
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "payroll.delete", entity: "user", entityId: e.user_id, data: { kind: e.kind, amount: e.amount_minor, month: e.month } });
    });
    return { ok: true };
  });

  /**
   * "My salary": the person signed in, and only them. Read-only; nobody's sheet but their own
   * can be reached here, whatever they send.
   */
  app.get("/me/payroll", { preHandler: authenticate }, async (req) => {
    const q = z.object({ month: z.string().regex(monthRe).optional() }).parse(req.query);
    const current = await monthStart(app.db);
    const month = await monthStart(app.db, q.month);
    if (month > current) throw new HttpError(400, "الشهر هذا لسه ما جاش");
    const s = await sheet(app.db, req.user.tid, req.user.sub, month);
    // The months this person has a sheet for (the current one always), newest first, up to a year.
    const history = (await app.db.query(
      `SELECT to_char(m, 'YYYY-MM') AS month FROM (
         SELECT month AS m FROM payroll_months WHERE user_id = $1 AND tenant_id = $2
         UNION SELECT month FROM payroll_entries WHERE user_id = $1 AND tenant_id = $2
         UNION SELECT $3::date) x WHERE m <= $3::date ORDER BY m DESC LIMIT 12`,
      [req.user.sub, req.user.tid, current],
    )).rows as { month: string }[];
    const months = [];
    for (const h of history) {
      const x = h.month === s.month ? s : await sheet(app.db, req.user.tid, req.user.sub, `${h.month}-01`);
      months.push({ month: h.month, netMinor: x.netMinor, paidMinor: x.paidMinor, remainingMinor: x.remainingMinor, deductionsMinor: x.deductionsMinor });
    }
    const { user, ...rest } = s;
    return { ...rest, user: { name: user.name, job_title: user.job_title, role: user.role, hired_on: user.hired_on, day_minutes: user.day_minutes }, months };
  });


}

/** A till sale put (partly) on an employee's salary. Runs inside the sale's transaction. */
export async function payrollPurchase(tx: Q, a: { tid: string; storeId: string; employeeId: string; employeeName: string; saleId: string; number: string; amountMinor: number; createdAt: string; by: string }) {
  const month = (await tx.query(`SELECT to_char(date_trunc('month', $1::timestamptz AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS m, ($1::timestamptz AT TIME ZONE '${TZ}')::date::text AS d`, [a.createdAt])).rows[0];
  await ensureMonth(tx, a.tid, a.employeeId, month.m);
  const exp = (await tx.query(
    `INSERT INTO expenses (tenant_id, store_id, category, amount_minor, note, spent_on, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [a.tid, a.storeId, EXPENSE_CATEGORY.purchase, a.amountMinor, `${a.employeeName} — فاتورة ${a.number}`, month.d, a.by],
  )).rows[0].id;
  await tx.query(
    `INSERT INTO payroll_entries (tenant_id, user_id, month, kind, amount_minor, on_date, note, sale_id, expense_id, created_by)
     VALUES ($1,$2,$3,'purchase',$4,$5,$6,$7,$8,$9)`,
    [a.tid, a.employeeId, month.m, a.amountMinor, month.d, `فاتورة ${a.number}`, a.saleId, exp, a.by],
  );
}

/** Goods bought on the salary coming back: the salary gets the money back, and the expense shrinks. */
export async function payrollReturn(tx: Q, a: { tid: string; employeeId: string; originalSaleId: string; returnId: string; number: string; amountMinor: number; by: string }) {
  const month = (await tx.query(`SELECT to_char(date_trunc('month', now() AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS m`, [])).rows[0].m as string;
  await ensureMonth(tx, a.tid, a.employeeId, month);
  await tx.query(
    `INSERT INTO payroll_entries (tenant_id, user_id, month, kind, amount_minor, note, sale_id, created_by) VALUES ($1,$2,$3,'return',$4,$5,$6,$7)`,
    [a.tid, a.employeeId, month, a.amountMinor, `مرتجع ${a.number}`, a.returnId, a.by],
  );
  const e = (await tx.query(`SELECT expense_id FROM payroll_entries WHERE sale_id = $1 AND kind = 'purchase' AND expense_id IS NOT NULL`, [a.originalSaleId])).rows[0];
  if (e) {
    const left = await tx.query(`UPDATE expenses SET amount_minor = amount_minor - $2 WHERE id = $1 AND amount_minor > $2 RETURNING id`, [e.expense_id, a.amountMinor]);
    if (!left.rowCount) await tx.query(`DELETE FROM expenses WHERE id = $1`, [e.expense_id]);
  }
}

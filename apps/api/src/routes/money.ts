import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, inTx } from "../db";
import { HttpError, requirePerm } from "../auth";

/**
 * The treasury: how much the shop has, at any moment, in cash, on the card account and in the
 * bank (transfers). Nothing is kept twice: the balance is added up from what the rest of the
 * system already records, plus what the owner enters by hand (an opening balance, money put in or
 * taken out, a move between accounts, a correction after counting).
 */

const TZ = "Africa/Tripoli";
export const ACCOUNTS = ["cash", "card", "transfer"] as const;
type Account = (typeof ACCOUNTS)[number];
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

/** Every movement of money, one row each: + in, − out. $1 = tenant. */
export const FLOWS = `
  SELECT s.created_at AS at, (s.created_at AT TIME ZONE '${TZ}')::date AS day,
         CASE p.method WHEN 'cash' THEN 'cash' ELSE 'card' END AS account,
         CASE WHEN s.kind = 'return' THEN 'refund' ELSE 'sale' END AS source,
         p.amount_minor - CASE WHEN p.method = 'cash' AND s.kind = 'sale' THEN s.change_minor ELSE 0 END AS amount,
         s.number AS ref, st.name AS detail, NULL::uuid AS movement_id
    FROM payments p JOIN sales s ON s.id = p.sale_id JOIN stores st ON st.id = s.store_id
   WHERE p.tenant_id = $1 AND p.method IN ('cash', 'card')
  UNION ALL
  SELECT cp.created_at, (cp.created_at AT TIME ZONE '${TZ}')::date, cp.method, 'customer', cp.amount_minor, c.name, cp.note, NULL
    FROM customer_payments cp JOIN customers c ON c.id = cp.customer_id WHERE cp.tenant_id = $1
  UNION ALL
  SELECT sp.created_at, (sp.created_at AT TIME ZONE '${TZ}')::date,
         CASE sp.method WHEN 'card' THEN 'card' WHEN 'transfer' THEN 'transfer' WHEN 'cheque' THEN 'transfer' ELSE 'cash' END,
         'supplier', -sp.amount_minor, su.name, sp.note, NULL
    FROM supplier_payments sp JOIN suppliers su ON su.id = sp.supplier_id WHERE sp.tenant_id = $1
  UNION ALL
  SELECT pi.created_at, pi.invoice_date,
         CASE pi.payment_method WHEN 'card' THEN 'card' WHEN 'transfer' THEN 'transfer' WHEN 'cheque' THEN 'transfer' ELSE 'cash' END,
         'purchase', -pi.total_minor, COALESCE(pi.supplier_ref, 'شراء نقدي'), pi.note, NULL
    FROM purchase_invoices pi WHERE pi.tenant_id = $1 AND pi.supplier_id IS NULL
  UNION ALL
  SELECT e.created_at, e.spent_on, e.payment_method, 'expense', -e.amount_minor, e.category, e.note, NULL
    FROM expenses e WHERE e.tenant_id = $1
  UNION ALL
  SELECT m.created_at, m.on_date, m.account, m.kind, m.amount_minor, NULL, m.note, m.id
    FROM money_movements m WHERE m.tenant_id = $1`;

const today = `(now() AT TIME ZONE '${TZ}')::date`;

export async function moneyRoutes(app: FastifyInstance) {
  const money = { preHandler: requirePerm("money") };

  /** Each account's balance now, today's and this month's in and out, and the last 30 days. */
  app.get("/money/summary", money, async (req) => {
    const tid = req.user.tid;
    const acc = (await app.db.query(
      `WITH f AS (${FLOWS})
       SELECT account,
              COALESCE(sum(amount), 0)::bigint AS balance,
              COALESCE(sum(amount) FILTER (WHERE day = ${today} AND amount > 0), 0)::bigint AS today_in,
              COALESCE(-sum(amount) FILTER (WHERE day = ${today} AND amount < 0), 0)::bigint AS today_out,
              COALESCE(sum(amount) FILTER (WHERE date_trunc('month', day) = date_trunc('month', ${today}) AND amount > 0), 0)::bigint AS month_in,
              COALESCE(-sum(amount) FILTER (WHERE date_trunc('month', day) = date_trunc('month', ${today}) AND amount < 0), 0)::bigint AS month_out
         FROM f GROUP BY account`,
      [tid],
    )).rows;
    const bySource = (await app.db.query(
      `WITH f AS (${FLOWS})
       SELECT account, source, sum(amount)::bigint AS amount, count(*)::int AS n FROM f
        WHERE date_trunc('month', day) = date_trunc('month', ${today}) GROUP BY account, source ORDER BY account, abs(sum(amount)) DESC`,
      [tid],
    )).rows;
    // End-of-day balance for each of the last 30 days.
    const series = (await app.db.query(
      `WITH f AS (${FLOWS}),
            days AS (SELECT d::date AS day FROM generate_series(${today} - 29, ${today}, interval '1 day') d)
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
              COALESCE(sum(f.amount) FILTER (WHERE f.account = 'cash'), 0)::bigint AS cash,
              COALESCE(sum(f.amount) FILTER (WHERE f.account = 'card'), 0)::bigint AS card,
              COALESCE(sum(f.amount) FILTER (WHERE f.account = 'transfer'), 0)::bigint AS transfer
         FROM days LEFT JOIN f ON f.day <= days.day GROUP BY days.day ORDER BY days.day`,
      [tid],
    )).rows;
    const accounts = Object.fromEntries(
      ACCOUNTS.map((a) => {
        const r = acc.find((x) => x.account === a);
        return [a, {
          balanceMinor: Number(r?.balance ?? 0), todayInMinor: Number(r?.today_in ?? 0), todayOutMinor: Number(r?.today_out ?? 0),
          monthInMinor: Number(r?.month_in ?? 0), monthOutMinor: Number(r?.month_out ?? 0),
          bySource: bySource.filter((x) => x.account === a).map((x) => ({ source: x.source as string, amountMinor: Number(x.amount), count: x.n as number })),
        }];
      }),
    ) as Record<Account, { balanceMinor: number; todayInMinor: number; todayOutMinor: number; monthInMinor: number; monthOutMinor: number; bySource: { source: string; amountMinor: number; count: number }[] }>;
    return {
      accounts,
      totalMinor: ACCOUNTS.reduce((s, a) => s + accounts[a].balanceMinor, 0),
      series: series.map((r) => ({ day: r.day as string, cash: Number(r.cash), card: Number(r.card), transfer: Number(r.transfer) })),
    };
  });

  /** One account's movements in a period, newest first, each with the balance after it. */
  app.get("/money/ledger", money, async (req) => {
    const q = z.object({
      account: z.enum(ACCOUNTS),
      from: z.string().regex(dateRe),
      to: z.string().regex(dateRe),
    }).parse(req.query);
    if (q.from > q.to) throw new HttpError(400, "تاريخ البداية بعد النهاية");
    const r = await app.db.query(
      `WITH f AS (${FLOWS}),
            run AS (SELECT f.*, sum(amount) OVER (ORDER BY day, at, ref NULLS FIRST ROWS UNBOUNDED PRECEDING)::bigint AS balance FROM f WHERE account = $2)
       SELECT to_char(day, 'YYYY-MM-DD') AS day, at, source, amount::bigint AS amount, ref, detail, movement_id, balance
         FROM run WHERE day BETWEEN $3::date AND $4::date ORDER BY day DESC, at DESC LIMIT 1000`,
      [req.user.tid, q.account, q.from, q.to],
    );
    const opening = (await app.db.query(`WITH f AS (${FLOWS}) SELECT COALESCE(sum(amount), 0)::bigint AS b FROM f WHERE account = $2 AND day < $3::date`, [req.user.tid, q.account, q.from])).rows[0].b;
    const rows = r.rows.map((x) => ({ ...x, amount: Number(x.amount), balance: Number(x.balance) }));
    return {
      openingMinor: Number(opening),
      inMinor: rows.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0),
      outMinor: -rows.filter((x) => x.amount < 0).reduce((a, x) => a + x.amount, 0),
      closingMinor: Number(opening) + rows.reduce((a, x) => a + x.amount, 0),
      rows,
    };
  });

  /** An opening balance, money put in or taken out, or a correction after counting (signed). */
  app.post("/money/movements", money, async (req) => {
    const b = z.object({
      account: z.enum(ACCOUNTS),
      kind: z.enum(["opening", "deposit", "withdrawal", "adjust"]),
      amountMinor: z.number().int().refine((n) => n !== 0, "المبلغ ما يكونش صفر").refine((n) => Math.abs(n) <= 1e13),
      note: z.string().max(200).optional(),
      onDate: z.string().regex(dateRe).optional(),
    }).parse(req.body);
    if (b.kind !== "adjust" && b.amountMinor < 0) throw new HttpError(400, "اكتب المبلغ موجب");
    const amount = b.kind === "withdrawal" ? -b.amountMinor : b.amountMinor;
    const r = await app.db.query(
      `INSERT INTO money_movements (tenant_id, account, kind, amount_minor, note, on_date, created_by) VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, ${today}),$7) RETURNING id`,
      [req.user.tid, b.account, b.kind, amount, b.note ?? null, b.onDate ?? null, req.user.sub],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: `money.${b.kind}`, entity: "money", entityId: r.rows[0].id, data: { account: b.account, amount, note: b.note } });
    return { id: r.rows[0].id };
  });

  /** Moving money between accounts, e.g. putting the day's cash in the bank. */
  app.post("/money/transfers", money, async (req) => {
    const b = z.object({
      from: z.enum(ACCOUNTS),
      to: z.enum(ACCOUNTS),
      amountMinor: z.number().int().positive().max(1e13),
      note: z.string().max(200).optional(),
      onDate: z.string().regex(dateRe).optional(),
    }).parse(req.body);
    if (b.from === b.to) throw new HttpError(400, "اختار حسابين مختلفين");
    const id = await inTx(app.db, async (tx) => {
      const tr = (await tx.query(`SELECT gen_random_uuid() AS id`, [])).rows[0].id as string;
      for (const [account, amount] of [[b.from, -b.amountMinor], [b.to, b.amountMinor]] as const) {
        await tx.query(
          `INSERT INTO money_movements (tenant_id, account, kind, amount_minor, transfer_id, note, on_date, created_by) VALUES ($1,$2,'transfer',$3,$4,$5,COALESCE($6::date, ${today}),$7)`,
          [req.user.tid, account, amount, tr, b.note ?? null, b.onDate ?? null, req.user.sub],
        );
      }
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "money.transfer", entity: "money", entityId: tr, data: b });
      return tr;
    });
    return { id };
  });

  /** Undoes a hand-entered movement (both halves of a transfer). */
  app.post("/money/movements/:id/delete", money, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await app.db.query(
      `DELETE FROM money_movements WHERE tenant_id = $1 AND (id = $2 OR transfer_id = (SELECT transfer_id FROM money_movements WHERE id = $2 AND tenant_id = $1))
       RETURNING account, kind, amount_minor`,
      [req.user.tid, id],
    );
    if (!r.rowCount) throw new HttpError(404, "الحركة غير موجودة");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "money.delete", entity: "money", entityId: id, data: { rows: r.rows } });
    return { ok: true };
  });
}

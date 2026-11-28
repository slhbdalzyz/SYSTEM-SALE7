import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, inTx } from "../db";
import { HttpError, authenticate, requirePerm } from "../auth";

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

/** The shop's default bank account: where bank and card money goes when nothing says otherwise. */
const DEF = `(SELECT id FROM bank_accounts WHERE tenant_id = $1 AND is_default)`;
const bank = (col: string, account: string) => `CASE WHEN ${account} = 'cash' THEN NULL ELSE COALESCE(${col}, ${DEF}) END`;

/**
 * Every movement of money, one row each: + in, − out. $1 = tenant.
 * `bank_id` says which bank account a card or bank row belongs to (none for cash), and `row_key`
 * names the row for ticking it off against the bank statement.
 */
export const FLOWS = `
  SELECT s.created_at AS at, (s.created_at AT TIME ZONE '${TZ}')::date AS day, x.account,
         ${bank("p.bank_account_id", "x.account")} AS bank_id,
         CASE WHEN s.kind = 'return' THEN 'refund' ELSE 'sale' END AS source,
         p.amount_minor - CASE WHEN p.method = 'cash' AND s.kind = 'sale' THEN s.change_minor ELSE 0 END AS amount,
         s.number AS ref, COALESCE(p.label, st.name) AS detail, NULL::uuid AS movement_id, 'p:' || p.id AS row_key
    FROM payments p JOIN sales s ON s.id = p.sale_id JOIN stores st ON st.id = s.store_id
    CROSS JOIN LATERAL (SELECT CASE WHEN p.method = 'cash' THEN 'cash' WHEN p.method IN ('transfer', 'cheque') THEN 'transfer' ELSE 'card' END AS account) x
   WHERE p.tenant_id = $1 AND p.method NOT IN ('credit', 'payroll', 'points')
  UNION ALL
  SELECT cp.created_at, (cp.created_at AT TIME ZONE '${TZ}')::date, cp.method, ${bank("cp.bank_account_id", "cp.method")},
         'customer', cp.amount_minor, c.name, cp.note, NULL, 'c:' || cp.id
    FROM customer_payments cp JOIN customers c ON c.id = cp.customer_id WHERE cp.tenant_id = $1
  UNION ALL
  SELECT sp.created_at, (sp.created_at AT TIME ZONE '${TZ}')::date, x.account, ${bank("sp.bank_account_id", "x.account")},
         'supplier', -sp.amount_minor, su.name, sp.note, NULL, 's:' || sp.id
    FROM supplier_payments sp JOIN suppliers su ON su.id = sp.supplier_id
    CROSS JOIN LATERAL (SELECT CASE sp.method WHEN 'card' THEN 'card' WHEN 'transfer' THEN 'transfer' WHEN 'cheque' THEN 'transfer' ELSE 'cash' END AS account) x
   WHERE sp.tenant_id = $1
  UNION ALL
  SELECT pi.created_at, pi.invoice_date, x.account, ${bank("pi.bank_account_id", "x.account")},
         'purchase', -pi.total_minor, COALESCE(pi.supplier_ref, 'شراء نقدي'), pi.note, NULL, 'i:' || pi.id
    FROM purchase_invoices pi
    CROSS JOIN LATERAL (SELECT CASE pi.payment_method WHEN 'card' THEN 'card' WHEN 'transfer' THEN 'transfer' WHEN 'cheque' THEN 'transfer' ELSE 'cash' END AS account) x
   WHERE pi.tenant_id = $1 AND pi.supplier_id IS NULL
  UNION ALL
  SELECT e.created_at, e.spent_on, e.payment_method, ${bank("e.bank_account_id", "e.payment_method")},
         'expense', -e.amount_minor, e.category, e.note, NULL, 'e:' || e.id
    FROM expenses e WHERE e.tenant_id = $1
  UNION ALL
  SELECT dm.created_at, (dm.created_at AT TIME ZONE '${TZ}')::date, 'cash', NULL, CASE dm.kind WHEN 'in' THEN 'drawer_in' ELSE 'drawer_out' END,
         CASE dm.kind WHEN 'in' THEN dm.amount_minor ELSE -dm.amount_minor END, d.name, dm.reason, NULL, 'd:' || dm.id
    FROM drawer_moves dm LEFT JOIN devices d ON d.id = dm.device_id WHERE dm.tenant_id = $1
  UNION ALL
  SELECT lm.created_at, (lm.created_at AT TIME ZONE '${TZ}')::date, 'cash', NULL,
         CASE WHEN l.kind = 'loan' THEN (CASE lm.kind WHEN 'open' THEN 'loan_out' ELSE 'loan_back' END) ELSE (CASE lm.kind WHEN 'open' THEN 'deposit_in' ELSE 'deposit_out' END) END,
         CASE WHEN (l.kind = 'loan') = (lm.kind = 'open') THEN -lm.amount_minor ELSE lm.amount_minor END, l.person_name, lm.note, NULL, 'l:' || lm.id
    FROM loan_moves lm JOIN loans l ON l.id = lm.loan_id WHERE lm.tenant_id = $1 AND lm.drawer_move_id IS NULL
  UNION ALL
  SELECT m.created_at, m.on_date, m.account, ${bank("m.bank_account_id", "m.account")}, m.kind, m.amount_minor, NULL, m.note, m.id, 'm:' || m.id
    FROM money_movements m WHERE m.tenant_id = $1`;

const today = `(now() AT TIME ZONE '${TZ}')::date`;

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A bank account id from the client, kept only if it is this shop's; otherwise null (the default account). */
export async function ownBank(q: Q, tid: string, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  return (await q.query(`SELECT id FROM bank_accounts WHERE id = $1 AND tenant_id = $2`, [id, tid])).rows[0]?.id ?? null;
}

/** The shop's bank accounts, default first. */
export async function listBanks(q: Q, tid: string) {
  return (await q.query(
    `SELECT id, bank_name AS "bankName", name, account_number AS "accountNumber", iban, is_default AS "isDefault", active
       FROM bank_accounts WHERE tenant_id = $1 ORDER BY is_default DESC, created_at`,
    [tid],
  )).rows as { id: string; bankName: string; name: string | null; accountNumber: string | null; iban: string | null; isDefault: boolean; active: boolean }[];
}

const amount = z.number().int().positive().max(1e13);
const bankId = z.string().uuid().nullable().optional();

export async function moneyRoutes(app: FastifyInstance) {
  const money = { preHandler: requirePerm("money") };

  /** Each account's balance now, today's and this month's in and out, and the last 30 days; and each bank account apart. */
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
    // Each bank account: what is in it, what card money is still on its way to it, and when it was last checked against a statement.
    const perBank = (await app.db.query(
      `WITH f AS (${FLOWS})
       SELECT bank_id,
              COALESCE(sum(amount) FILTER (WHERE account = 'transfer'), 0)::bigint AS balance,
              COALESCE(sum(amount) FILTER (WHERE account = 'card'), 0)::bigint AS pending,
              COALESCE(sum(amount) FILTER (WHERE account = 'transfer' AND day = ${today} AND amount > 0), 0)::bigint AS today_in,
              COALESCE(-sum(amount) FILTER (WHERE account = 'transfer' AND day = ${today} AND amount < 0), 0)::bigint AS today_out
         FROM f WHERE bank_id IS NOT NULL GROUP BY bank_id`,
      [tid],
    )).rows;
    const lastRec = (await app.db.query(
      `SELECT DISTINCT ON (bank_account_id) bank_account_id, to_char(statement_date, 'YYYY-MM-DD') AS day, statement_minor, cleared_minor
         FROM bank_reconciliations WHERE tenant_id = $1 ORDER BY bank_account_id, statement_date DESC, created_at DESC`,
      [tid],
    )).rows;
    const banks = (await listBanks(app.db, tid)).map((b) => {
      const r = perBank.find((x) => x.bank_id === b.id);
      const l = lastRec.find((x) => x.bank_account_id === b.id);
      return {
        ...b, balanceMinor: Number(r?.balance ?? 0), pendingCardMinor: Number(r?.pending ?? 0),
        todayInMinor: Number(r?.today_in ?? 0), todayOutMinor: Number(r?.today_out ?? 0),
        lastReconciled: l ? { day: l.day as string, differenceMinor: Number(l.statement_minor) - Number(l.cleared_minor) } : null,
      };
    });
    return {
      accounts,
      banks,
      totalMinor: ACCOUNTS.reduce((s, a) => s + accounts[a].balanceMinor, 0),
      series: series.map((r) => ({ day: r.day as string, cash: Number(r.cash), card: Number(r.card), transfer: Number(r.transfer) })),
    };
  });

  /** One account's movements in a period (or one bank account's), newest first, each with the balance after it. */
  app.get("/money/ledger", money, async (req) => {
    const q = z.object({
      account: z.enum(ACCOUNTS),
      from: z.string().regex(dateRe),
      to: z.string().regex(dateRe),
      bankId: z.string().uuid().optional(),
    }).parse(req.query);
    if (q.from > q.to) throw new HttpError(400, "تاريخ البداية بعد النهاية");
    const scope = `account = $2 AND ($5::uuid IS NULL OR bank_id = $5)`;
    const r = await app.db.query(
      `WITH f AS (${FLOWS}),
            run AS (SELECT f.*, sum(amount) OVER (ORDER BY day, at, ref NULLS FIRST, row_key ROWS UNBOUNDED PRECEDING)::bigint AS balance FROM f WHERE ${scope})
       SELECT to_char(day, 'YYYY-MM-DD') AS day, at, source, amount::bigint AS amount, ref, detail, movement_id, balance, run.row_key,
              (mc.row_key IS NOT NULL) AS cleared
         FROM run LEFT JOIN money_cleared mc ON mc.tenant_id = $1 AND mc.row_key = run.row_key
        WHERE day BETWEEN $3::date AND $4::date ORDER BY day DESC, at DESC LIMIT 1000`,
      [req.user.tid, q.account, q.from, q.to, q.bankId ?? null],
    );
    const opening = (await app.db.query(
      `WITH f AS (${FLOWS}) SELECT COALESCE(sum(amount), 0)::bigint AS b FROM f WHERE account = $2 AND ($4::uuid IS NULL OR bank_id = $4) AND day < $3::date`,
      [req.user.tid, q.account, q.from, q.bankId ?? null],
    )).rows[0].b;
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
      bankId,
      kind: z.enum(["opening", "deposit", "withdrawal", "adjust"]),
      amountMinor: z.number().int().refine((n) => n !== 0, "المبلغ ما يكونش صفر").refine((n) => Math.abs(n) <= 1e13),
      note: z.string().max(200).optional(),
      onDate: z.string().regex(dateRe).optional(),
    }).parse(req.body);
    if (b.kind !== "adjust" && b.amountMinor < 0) throw new HttpError(400, "اكتب المبلغ موجب");
    const amt = b.kind === "withdrawal" ? -b.amountMinor : b.amountMinor;
    const bank = b.account === "cash" ? null : await ownBank(app.db, req.user.tid, b.bankId);
    const r = await app.db.query(
      `INSERT INTO money_movements (tenant_id, account, kind, amount_minor, note, on_date, created_by, bank_account_id) VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, ${today}),$7,$8) RETURNING id`,
      [req.user.tid, b.account, b.kind, amt, b.note ?? null, b.onDate ?? null, req.user.sub, bank],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: `money.${b.kind}`, entity: "money", entityId: r.rows[0].id, data: { account: b.account, bank, amount: amt, note: b.note } });
    return { id: r.rows[0].id };
  });

  /** Moving money between accounts: the day's cash into the bank, or from one bank to another. */
  app.post("/money/transfers", money, async (req) => {
    const b = z.object({
      from: z.enum(ACCOUNTS),
      to: z.enum(ACCOUNTS),
      fromBankId: bankId,
      toBankId: bankId,
      amountMinor: amount,
      note: z.string().max(200).optional(),
      onDate: z.string().regex(dateRe).optional(),
    }).parse(req.body);
    const fromBank = b.from === "cash" ? null : await ownBank(app.db, req.user.tid, b.fromBankId);
    const toBank = b.to === "cash" ? null : await ownBank(app.db, req.user.tid, b.toBankId);
    if (b.from === b.to && fromBank === toBank) throw new HttpError(400, "اختار حسابين مختلفين");
    const id = await inTx(app.db, async (tx) => {
      const tr = (await tx.query(`SELECT gen_random_uuid() AS id`, [])).rows[0].id as string;
      for (const [account, bank, amt] of [[b.from, fromBank, -b.amountMinor], [b.to, toBank, b.amountMinor]] as const) {
        await tx.query(
          `INSERT INTO money_movements (tenant_id, account, kind, amount_minor, transfer_id, note, on_date, created_by, bank_account_id) VALUES ($1,$2,'transfer',$3,$4,$5,COALESCE($6::date, ${today}),$7,$8)`,
          [req.user.tid, account, amt, tr, b.note ?? null, b.onDate ?? null, req.user.sub, bank],
        );
      }
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "money.transfer", entity: "money", entityId: tr, data: { ...b, fromBank, toBank } });
      return tr;
    });
    return { id };
  });

  /**
   * The bank paid in card money: it leaves "under settlement" and lands in the bank account, and
   * the bank's commission is booked as an expense paid from that account.
   */
  app.post("/money/settlements", money, async (req) => {
    const b = z.object({
      bankId: z.string().uuid().nullable().optional(),
      grossMinor: amount,
      feeMinor: z.number().int().min(0).max(1e13).default(0),
      note: z.string().max(200).optional(),
      onDate: z.string().regex(dateRe).optional(),
    }).parse(req.body);
    if (b.feeMinor >= b.grossMinor) throw new HttpError(400, "العمولة أكبر من المبلغ");
    const bank = await ownBank(app.db, req.user.tid, b.bankId);
    const id = await inTx(app.db, async (tx) => {
      const st = (await tx.query(`SELECT gen_random_uuid() AS id`, [])).rows[0].id as string;
      for (const [account, amt] of [["card", -b.grossMinor], ["transfer", b.grossMinor]] as const) {
        await tx.query(
          `INSERT INTO money_movements (tenant_id, account, kind, amount_minor, settlement_id, note, on_date, created_by, bank_account_id) VALUES ($1,$2,'settlement',$3,$4,$5,COALESCE($6::date, ${today}),$7,$8)`,
          [req.user.tid, account, amt, st, b.note ?? null, b.onDate ?? null, req.user.sub, bank],
        );
      }
      if (b.feeMinor > 0) {
        const store = (await tx.query(`SELECT id FROM stores WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [req.user.tid])).rows[0].id;
        await tx.query(
          `INSERT INTO expenses (tenant_id, store_id, category, amount_minor, note, spent_on, user_id, payment_method, bank_account_id, settlement_id)
           VALUES ($1,$2,'عمولة البطاقات',$3,$4,COALESCE($5::date, ${today}),$6,'transfer',$7,$8)`,
          [req.user.tid, store, b.feeMinor, b.note ?? "عمولة تسوية البطاقات", b.onDate ?? null, req.user.sub, bank, st],
        );
      }
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "money.settlement", entity: "money", entityId: st, data: { ...b, bank } });
      return st;
    });
    return { id };
  });

  /** Undoes a hand-entered movement (both halves of a transfer, or a whole settlement with its commission). */
  app.post("/money/movements/:id/delete", money, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await inTx(app.db, async (tx) => {
      const m = (await tx.query(`SELECT transfer_id, settlement_id FROM money_movements WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid])).rows[0];
      if (!m) return null;
      const del = await tx.query(
        `DELETE FROM money_movements WHERE tenant_id = $1 AND (id = $2 OR transfer_id = $3 OR settlement_id = $4) RETURNING account, kind, amount_minor`,
        [req.user.tid, id, m.transfer_id, m.settlement_id],
      );
      if (m.settlement_id) await tx.query(`DELETE FROM expenses WHERE tenant_id = $1 AND settlement_id = $2`, [req.user.tid, m.settlement_id]);
      return del.rows;
    });
    if (!r) throw new HttpError(404, "الحركة غير موجودة");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "money.delete", entity: "money", entityId: id, data: { rows: r } });
    return { ok: true };
  });

  // ── Bank accounts ──────────────────────────────────────────────────────────────────
  /** Anyone who records money (the till, purchases, expenses) needs to pick an account. */
  app.get("/money/banks", { preHandler: authenticate }, async (req) => listBanks(app.db, req.user.tid));

  const bankBody = z.object({
    bankName: z.string().trim().min(2).max(80),
    name: z.string().trim().max(80).nullable().optional(),
    accountNumber: z.string().trim().max(40).nullable().optional(),
    iban: z.string().trim().max(40).nullable().optional(),
  });

  app.post("/money/banks", money, async (req) => {
    const b = bankBody.extend({ openingMinor: z.number().int().min(-1e13).max(1e13).optional(), openingDate: z.string().regex(dateRe).optional() }).parse(req.body);
    const id = await inTx(app.db, async (tx) => {
      const first = !(await tx.query(`SELECT 1 FROM bank_accounts WHERE tenant_id = $1`, [req.user.tid])).rowCount;
      const r = await tx.query(
        `INSERT INTO bank_accounts (tenant_id, bank_name, name, account_number, iban, is_default) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.user.tid, b.bankName, b.name || null, b.accountNumber || null, b.iban || null, first],
      );
      const bid = r.rows[0].id as string;
      if (b.openingMinor) {
        await tx.query(
          `INSERT INTO money_movements (tenant_id, account, kind, amount_minor, note, on_date, created_by, bank_account_id) VALUES ($1,'transfer','opening',$2,$3,COALESCE($4::date, ${today}),$5,$6)`,
          [req.user.tid, b.openingMinor, `رصيد افتتاحي ${b.bankName}`, b.openingDate ?? null, req.user.sub, bid],
        );
      }
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "bank.create", entity: "bank_account", entityId: bid, data: b });
      return bid;
    });
    return { id };
  });

  app.patch("/money/banks/:id", money, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = bankBody.partial().extend({ isDefault: z.literal(true).optional(), active: z.boolean().optional() }).parse(req.body);
    await inTx(app.db, async (tx) => {
      const cur = (await tx.query(`SELECT is_default FROM bank_accounts WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid])).rows[0];
      if (!cur) throw new HttpError(404, "الحساب غير موجود");
      if (b.active === false && cur.is_default) throw new HttpError(400, "اختار حساب ثاني كحساب رئيسي قبل ما توقف هذا");
      if (b.isDefault) {
        await tx.query(`UPDATE bank_accounts SET is_default = false WHERE tenant_id = $1 AND is_default`, [req.user.tid]);
        await tx.query(`UPDATE bank_accounts SET is_default = true, active = true WHERE id = $1`, [id]);
      }
      await tx.query(
        `UPDATE bank_accounts SET bank_name = COALESCE($3, bank_name), name = CASE WHEN $4::boolean THEN $5 ELSE name END,
                account_number = CASE WHEN $6::boolean THEN $7 ELSE account_number END, iban = CASE WHEN $8::boolean THEN $9 ELSE iban END,
                active = COALESCE($10, active)
          WHERE id = $1 AND tenant_id = $2`,
        [id, req.user.tid, b.bankName ?? null, b.name !== undefined, b.name || null, b.accountNumber !== undefined, b.accountNumber || null, b.iban !== undefined, b.iban || null, b.active ?? null],
      );
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "bank.update", entity: "bank_account", entityId: id, data: b });
    });
    return { ok: true };
  });

  // ── Checking against the bank statement ────────────────────────────────────────────
  /** Ticks movements off (or back on) as they show on the bank statement. */
  app.post("/money/cleared", money, async (req) => {
    const b = z.object({ rowKeys: z.array(z.string().regex(/^[pcsiedm]:[0-9a-f-]{36}$/)).min(1).max(500), cleared: z.boolean() }).parse(req.body);
    if (b.cleared) {
      await app.db.query(
        `INSERT INTO money_cleared (tenant_id, row_key, cleared_by) SELECT $1, k, $3 FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`,
        [req.user.tid, b.rowKeys, req.user.sub],
      );
    } else {
      await app.db.query(`DELETE FROM money_cleared WHERE tenant_id = $1 AND row_key = ANY($2::text[])`, [req.user.tid, b.rowKeys]);
    }
    return { ok: true };
  });

  /** A bank account's balances on a date: in the books, and counting only what is ticked off. */
  async function balances(tid: string, bank: string, day: string) {
    const r = (await app.db.query(
      `WITH f AS (${FLOWS})
       SELECT COALESCE(sum(amount), 0)::bigint AS book,
              COALESCE(sum(amount) FILTER (WHERE mc.row_key IS NOT NULL), 0)::bigint AS cleared,
              count(*) FILTER (WHERE mc.row_key IS NULL)::int AS open
         FROM f LEFT JOIN money_cleared mc ON mc.tenant_id = $1 AND mc.row_key = f.row_key
        WHERE f.account = 'transfer' AND f.bank_id = $2 AND f.day <= $3::date`,
      [tid, bank, day],
    )).rows[0];
    return { bookMinor: Number(r.book), clearedMinor: Number(r.cleared), openCount: r.open as number };
  }

  app.get("/money/reconciliations", money, async (req) => {
    const q = z.object({ bankId: z.string().uuid(), day: z.string().regex(dateRe).optional() }).parse(req.query);
    const bank = await ownBank(app.db, req.user.tid, q.bankId);
    if (!bank) throw new HttpError(404, "الحساب غير موجود");
    const day = q.day ?? (await app.db.query(`SELECT to_char(${today}, 'YYYY-MM-DD') AS d`)).rows[0].d;
    const history = (await app.db.query(
      `SELECT r.id, to_char(r.statement_date, 'YYYY-MM-DD') AS day, r.statement_minor, r.book_minor, r.cleared_minor, r.note, r.created_at, u.name AS by
         FROM bank_reconciliations r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.tenant_id = $1 AND r.bank_account_id = $2 ORDER BY r.statement_date DESC, r.created_at DESC LIMIT 50`,
      [req.user.tid, bank],
    )).rows.map((r) => ({ ...r, statement_minor: Number(r.statement_minor), book_minor: Number(r.book_minor), cleared_minor: Number(r.cleared_minor) }));
    return { day, ...(await balances(req.user.tid, bank, day)), history };
  });

  /** Writes down what the bank statement said on a date, next to the books, so the difference is on record. */
  app.post("/money/reconciliations", money, async (req) => {
    const b = z.object({ bankId: z.string().uuid(), statementDate: z.string().regex(dateRe), statementMinor: z.number().int().min(-1e13).max(1e13), note: z.string().max(200).optional() }).parse(req.body);
    const bank = await ownBank(app.db, req.user.tid, b.bankId);
    if (!bank) throw new HttpError(404, "الحساب غير موجود");
    const bal = await balances(req.user.tid, bank, b.statementDate);
    const r = await app.db.query(
      `INSERT INTO bank_reconciliations (tenant_id, bank_account_id, statement_date, statement_minor, book_minor, cleared_minor, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.tid, bank, b.statementDate, b.statementMinor, bal.bookMinor, bal.clearedMinor, b.note ?? null, req.user.sub],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "bank.reconcile", entity: "bank_account", entityId: bank, data: { ...b, ...bal } });
    return { id: r.rows[0].id, ...bal, differenceMinor: b.statementMinor - bal.clearedMinor };
  });
}

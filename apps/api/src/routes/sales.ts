import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyOffers, computeLine, computeTotals, normSerial, pointsEarned, pointsFor, recipeCost, recipeUsage, saleInputSchema, warrantyUntil, type SaleInput } from "@pos/shared";
import { addPoints, customerPoints, loyaltySettings } from "../loyalty";
import { currentOffers } from "./offers";
import { openPriceProducts } from "./quick";
import { checkDueLoans } from "./loans";
import { alertBigDiscount, alertOverCreditLimit, checkForgottenShifts, checkLowStock, checkZakatDue, flushPushes } from "../alerts";
import { audit, inTx, type Tx } from "../db";
import { checkExpirySoon } from "../expiry";
import { requireDevice } from "../auth";
import { payrollPurchase } from "./payroll";
import type { TokenPayload } from "../auth";

type Result = { id: string; status: "accepted" | "duplicate" } | { id: string; status: "rejected"; error: string };

class Reject extends Error {}

export async function salesRoutes(app: FastifyInstance) {
  /**
   * Cashier devices send sales in batches from their offline outbox.
   * The sale id is made on the device, so sending the same sale twice records it once.
   */
  app.post("/sales/batch", { preHandler: requireDevice }, async (req) => {
    const { sales } = z.object({ sales: z.array(z.unknown()).min(1).max(100) }).parse(req.body);
    const results: Result[] = [];
    for (const raw of sales) {
      const parsed = saleInputSchema.safeParse(raw);
      const id = (raw as { id?: string })?.id ?? "unknown";
      if (!parsed.success) {
        results.push({ id, status: "rejected", error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        continue;
      }
      try {
        results.push(await recordSale(app, req.user, parsed.data));
      } catch (e) {
        if (e instanceof Reject) results.push({ id, status: "rejected", error: e.message });
        else throw e;
      }
    }
    if (results.some((r) => r.status === "accepted")) {
      await checkZakatDue(app.db, req.user.tid).catch(() => false);
      await checkExpirySoon(app.db, req.user.tid).catch(() => false);
      await checkForgottenShifts(app.db, req.user.tid).catch(() => 0);
      await checkDueLoans(app.db, req.user.tid).catch(() => 0);
      await flushPushes(app.db, req.user.tid);
    }
    return { results };
  });

  app.get("/sales", { preHandler: requireDevice }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const r = await app.db.query(
      `SELECT s.id, s.number, s.kind, s.total_minor, s.created_at, u.name AS cashier FROM sales s JOIN users u ON u.id = s.user_id
       WHERE s.tenant_id = $1 AND s.store_id = $2 ORDER BY s.created_at DESC LIMIT $3`,
      [req.user.tid, req.user.sid, limit],
    );
    return r.rows;
  });
}

/**
 * Marks the pieces sold. A number the shop never entered is still taken (the box was in stock
 * before the numbers were) and kept as sold; one already sold, or a line short of numbers, is
 * logged for the owner to look at. The sale itself always stands: the customer has the phone.
 */
async function sellSerials(tx: Tx, a: { tid: string; who: TokenPayload; saleId: string; number: string; at: string; productId: string; name: string; pieces: number; serials: string[]; warranty: string | null }) {
  const twice: string[] = [];
  for (const serial of a.serials) {
    const was = (await tx.query(`SELECT id, status, product_id FROM product_serials WHERE tenant_id = $1 AND serial = $2 FOR UPDATE`, [a.tid, serial])).rows[0];
    if (was?.status === "sold") twice.push(serial);
    if (was) {
      await tx.query(
        `UPDATE product_serials SET status = 'sold', sale_id = $2, sold_at = $3, warranty_until = $4, store_id = $5, product_id = CASE WHEN $6::boolean THEN product_id ELSE $7 END WHERE id = $1`,
        [was.id, a.saleId, a.at, a.warranty, a.who.sid, was.status === "sold", a.productId],
      );
    } else {
      await tx.query(
        `INSERT INTO product_serials (tenant_id, product_id, store_id, serial, status, sale_id, sold_at, warranty_until, note, created_by) VALUES ($1,$2,$3,$4,'sold',$5,$6,$7,'بيع قبل تسجيل الرقم',$8)`,
        [a.tid, a.productId, a.who.sid, serial, a.saleId, a.at, a.warranty, a.who.sub],
      );
    }
  }
  // The phone left the shop: the till's list of numbers in stock has to drop it.
  await tx.query(`UPDATE products SET updated_at = now() WHERE id = $1`, [a.productId]);
  if (twice.length) {
    await audit(tx, { tenantId: a.tid, userId: a.who.sub, deviceId: a.who.did, action: "sale.serial_twice", entity: "sale", entityId: a.saleId, data: { sale: a.number, item: a.name, serials: twice } });
  }
  if (a.serials.length < a.pieces) {
    await audit(tx, { tenantId: a.tid, userId: a.who.sub, deviceId: a.who.did, action: "sale.serial_missing", entity: "sale", entityId: a.saleId, data: { sale: a.number, item: a.name, missing: a.pieces - a.serials.length } });
  }
}

async function recordSale(app: FastifyInstance, who: TokenPayload, s: SaleInput): Promise<Result> {
  const tid = who.tid;
  const dup = await app.db.query(`SELECT tenant_id FROM sales WHERE id = $1`, [s.id]);
  if (dup.rowCount) {
    if (dup.rows[0].tenant_id !== tid) throw new Reject("معرّف مكرر");
    return { id: s.id, status: "duplicate" };
  }

  const totals = computeTotals(s.lines, s.invoiceDiscountMinor);
  if (totals.total !== s.totalMinor) throw new Reject(`الإجمالي غير مطابق (${s.totalMinor} ≠ ${totals.total})`);
  const credit = s.payments.filter((p) => p.method === "credit").reduce((a, p) => a + p.amountMinor, 0);
  let customer: { name: string; credit_limit_minor: number | null; balance_minor: number; price_tier: string } | undefined;
  if (s.customerId) {
    customer = (await app.db.query(
      `SELECT c.name, c.credit_limit_minor, c.price_tier, b.balance_minor FROM customers c JOIN customer_balances b ON b.customer_id = c.id WHERE c.id = $1 AND c.tenant_id = $2`,
      [s.customerId, tid],
    )).rows[0];
    if (!customer) throw new Reject("العميل غير موجود");
  }
  if (credit > 0 && !customer) throw new Reject("البيع الآجل يحتاج عميل");
  const pointsPaid = s.payments.filter((p) => p.method === "points").reduce((a, p) => a + p.amountMinor, 0);
  if (pointsPaid > 0 && !customer) throw new Reject("الدفع بالنقاط يحتاج عميل");
  if (pointsPaid > totals.total) throw new Reject("النقاط أكبر من الإجمالي");
  const paid = s.payments.reduce((a, p) => a + p.amountMinor, 0);
  const cash = s.payments.filter((p) => p.method === "cash").reduce((a, p) => a + p.amountMinor, 0);
  if (paid < totals.total) throw new Reject("المدفوع أقل من الإجمالي");
  const change = paid - totals.total;
  if (change > cash) throw new Reject("الباقي ما يكونش أكبر من المدفوع كاش");
  if (credit > totals.total) throw new Reject("الآجل أكبر من الإجمالي");
  const onSalary = s.payments.filter((p) => p.method === "payroll").reduce((a, p) => a + p.amountMinor, 0);
  let employee: { name: string } | undefined;
  if (s.employeeId) {
    employee = (await app.db.query(`SELECT name FROM users WHERE id = $1 AND tenant_id = $2`, [s.employeeId, tid])).rows[0];
    if (!employee) throw new Reject("الموظف غير موجود");
  }
  if (onSalary > 0 && !employee) throw new Reject("الخصم من الراتب يحتاج موظف");
  if (onSalary + credit > totals.total) throw new Reject("الآجل والخصم من الراتب أكبر من الإجمالي");

  const unitIds = [...new Set(s.lines.map((l) => l.unitId))];
  const units = await app.db.query(
    `SELECT u.id, u.product_id, u.factor_milli, u.price_minor, u.is_base, p.cost_minor, p.name, p.category_id, p.is_weighted, p.rx, p.serialized, p.warranty_months, p.is_service
     FROM product_units u JOIN products p ON p.id = u.product_id WHERE u.tenant_id = $1 AND u.id = ANY($2)`,
    [tid, unitIds],
  );
  const byUnit = new Map(units.rows.map((u) => [u.id as string, u]));
  for (const l of s.lines) {
    const u = byUnit.get(l.unitId);
    if (!u || u.product_id !== l.productId) throw new Reject(`الصنف غير موجود: ${l.name}`);
  }
  // A contractor or a workshop pays its own price: not an override.
  const tierPrices = new Map<string, number>();
  if (customer && customer.price_tier !== "retail") {
    const tp = await app.db.query(`SELECT unit_id, price_minor FROM unit_prices WHERE tenant_id = $1 AND tier = $2 AND unit_id = ANY($3::uuid[])`, [tid, customer.price_tier, unitIds]);
    for (const r of tp.rows) tierPrices.set(r.unit_id, Number(r.price_minor));
  }
  // The quote it was opened from, still open.
  const quote = s.quoteId ? (await app.db.query(`SELECT id, number FROM quotes WHERE id = $1 AND tenant_id = $2 AND status = 'open'`, [s.quoteId, tid])).rows[0] : undefined;

  // The device works out offers offline. Redo it here with the offers as the server knows them;
  // a difference means the device had an old list, so the sale stands and gets flagged.
  const offers = await currentOffers(app.db, tid);
  const expected = applyOffers(
    s.lines.map((l) => {
      const u = byUnit.get(l.unitId)!;
      return { productId: l.productId, categoryId: u.category_id, priceMinor: l.priceMinor, qtyMilli: l.qtyMilli, isBaseUnit: u.is_base, isWeighted: u.is_weighted };
    }),
    offers,
    new Date(s.createdAt),
    who.sid ?? null,
  );
  const offerMismatch = s.lines.some((l, i) => l.promoMinor !== expected.promo[i] || (l.promoMinor > 0 && (l.offerId ?? null) !== expected.offerIds[i]));
  const claimed = [...new Set(s.lines.map((l) => l.offerId).filter((x): x is string => !!x))];
  const knownOffers = new Set(
    claimed.length ? (await app.db.query(`SELECT id FROM offers WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tid, claimed])).rows.map((r) => r.id as string) : [],
  );

  // Prescription-only medicines: the sale is kept even without one (the till may have been
  // offline on an old catalog), and the missing prescription is logged for the pharmacist.
  const rxNames = [...new Set(s.lines.filter((l) => byUnit.get(l.unitId)!.rx).map((l) => byUnit.get(l.unitId)!.name as string))];
  const rxMissing = rxNames.length > 0 && !(s.prescription && (s.prescription.doctor || s.prescription.number || s.prescription.patient));

  // Restaurants: a dish with a recipe takes its ingredients out of stock, and costs what they cost.
  const recipes = new Map<string, { ingredientId: string; qtyMilli: number }[]>();
  const rl = await app.db.query(
    `SELECT r.product_id, r.ingredient_id, r.qty_milli FROM recipe_lines r WHERE r.tenant_id = $1 AND r.product_id = ANY($2::uuid[])`,
    [tid, [...new Set(s.lines.map((l) => l.productId))]],
  );
  for (const r of rl.rows) recipes.set(r.product_id, [...(recipes.get(r.product_id) ?? []), { ingredientId: r.ingredient_id, qtyMilli: Number(r.qty_milli) }]);
  const ingredientCost = recipes.size
    ? new Map((await app.db.query(`SELECT id, cost_minor FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tid, [...new Set(rl.rows.map((r) => r.ingredient_id))]])).rows.map((r) => [r.id as string, Number(r.cost_minor)]))
    : new Map<string, number>();

  if (s.shiftId) {
    const sh = await app.db.query(`SELECT 1 FROM shifts WHERE id = $1 AND tenant_id = $2 AND device_id = $3`, [s.shiftId, tid, who.did]);
    if (!sh.rowCount) throw new Reject("الوردية غير موجودة على هذا الجهاز");
  }

  try {
    await inTx(app.db, async (tx) => {
      await tx.query(
        `INSERT INTO sales (id, tenant_id, store_id, device_id, shift_id, user_id, number, subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, change_minor, created_at, customer_id, employee_id, prescription, order_type, table_name, quote_id, project, delivery)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [s.id, tid, who.sid, who.did, s.shiftId ?? null, who.sub, s.number, totals.subtotal, totals.discount, totals.tax, totals.total, paid, change, s.createdAt, s.customerId ?? null, onSalary > 0 ? s.employeeId : null,
          rxNames.length ? JSON.stringify(s.prescription ?? {}) : null, s.orderType ?? null, s.tableName || null,
          quote?.id ?? null, s.project || null, s.delivery ? JSON.stringify({ ...s.delivery, status: "pending" }) : null],
      );
      const overrides: { name: string; catalog: number; sold: number }[] = [];
      const taken = new Map<string, number>();
      // Keys set to "open price" sell at whatever the cashier types: not an override.
      const openPrice = await openPriceProducts(tx, tid);
      for (const l of s.lines) {
        const u = byUnit.get(l.unitId)!;
        const t = computeLine(l);
        const baseQty = Math.round((l.qtyMilli * u.factor_milli) / 1000);
        const recipe = recipes.get(l.productId);
        const unitCost = recipe ? recipeCost(recipe, ingredientCost) : Number(u.cost_minor);
        const cost = Math.round((unitCost * baseQty) / 1000);
        // Electronics: the numbers of the pieces sold, and the warranty they carry from today.
        const serials = [...new Set((l.serials ?? []).map(normSerial).filter(Boolean))];
        const warranty = warrantyUntil(s.createdAt, Number(u.warranty_months ?? 0));
        await tx.query(
          `INSERT INTO sale_lines (tenant_id, sale_id, product_id, unit_id, name, qty_milli, price_minor, discount_minor, tax_minor, total_minor, cost_minor, promo_minor, offer_id, note, serials, warranty_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [tid, s.id, l.productId, l.unitId, l.name, l.qtyMilli, l.priceMinor, t.discount, t.tax, t.total, cost, Math.min(l.promoMinor, t.discount),
            l.offerId && knownOffers.has(l.offerId) ? l.offerId : null, l.note || null, serials.length ? serials : null, warranty],
        );
        if (u.serialized || serials.length) await sellSerials(tx, { tid, who, saleId: s.id, number: s.number, at: s.createdAt, productId: l.productId, name: l.name, pieces: Math.round(baseQty / 1000), serials, warranty });
        // A service takes nothing from stock, unless it has a recipe of the parts it uses.
        const usage = u.is_service && !recipe ? [] : recipeUsage([{ productId: l.productId, baseMilli: baseQty }], recipes);
        for (const [productId, qty] of usage) {
          await tx.query(
            // Dated when the sale was made, not when an offline till sent it, so a stock count
            // taken in between compares with the right figure.
            `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, user_id, created_at) VALUES ($1,$2,$3,$4,'sale',$5,$6,LEAST($7::timestamptz, now()))`,
            [tid, who.sid, productId, -qty, s.id, who.sub, s.createdAt],
          );
          taken.set(productId, (taken.get(productId) ?? 0) + qty);
        }
        if (l.priceMinor !== u.price_minor && l.priceMinor !== tierPrices.get(l.unitId) && !openPrice.has(l.productId)) overrides.push({ name: l.name, catalog: u.price_minor, sold: l.priceMinor });
      }
      if (quote) await tx.query(`UPDATE quotes SET status = 'sold', sale_id = $2 WHERE id = $1`, [quote.id, s.id]);
      for (const p of s.payments) {
        // A shop's own way of paying only ever counts as card or transfer money.
        const label = p.label && (p.method === "card" || p.method === "transfer") ? p.label : null;
        // Which bank account it lands in: the one the till chose, else (card money) the account of this till's card machine,
        // else the shop's default account (worked out when the treasury adds up).
        await tx.query(
          `INSERT INTO payments (tenant_id, sale_id, method, amount_minor, label, bank_account_id) VALUES ($1,$2,$3,$4,$5,
             CASE WHEN $3 IN ('cash', 'credit', 'payroll', 'points') THEN NULL
                  ELSE COALESCE((SELECT id FROM bank_accounts WHERE id = $6::uuid AND tenant_id = $1),
                                CASE WHEN $3 NOT IN ('transfer', 'cheque') THEN (SELECT card_bank_id FROM devices WHERE id = $7 AND tenant_id = $1) END) END)`,
          [tid, s.id, p.method, p.amountMinor, label, p.bankAccountId ?? null, who.did ?? null],
        );
      }
      if (onSalary > 0) {
        await payrollPurchase(tx, { tid, storeId: who.sid!, employeeId: s.employeeId!, employeeName: employee!.name, saleId: s.id, number: s.number, amountMinor: onSalary, createdAt: s.createdAt, by: who.sub });
      }
      // A price different from the catalog is either an offline device with old prices or a manual override; both are worth a look.
      if (overrides.length) {
        await audit(tx, { tenantId: tid, userId: who.sub, deviceId: who.did, action: "sale.price_mismatch", entity: "sale", entityId: s.id, data: { overrides } });
      }
      // An offline device may have sold on credit past the limit; the sale already happened, so it is kept and flagged.
      if (customer && credit > 0 && customer.credit_limit_minor !== null && customer.balance_minor + credit > customer.credit_limit_minor) {
        await audit(tx, { tenantId: tid, userId: who.sub, deviceId: who.did, action: "customer.over_limit", entity: "customer", entityId: s.customerId!, data: { sale: s.number, balance: customer.balance_minor + credit, limit: customer.credit_limit_minor } });
        await alertOverCreditLimit(tx, { tenantId: tid, storeId: who.sid!, customer: customer.name, balanceMinor: customer.balance_minor + credit, limitMinor: customer.credit_limit_minor });
      }
      if (rxMissing) {
        await audit(tx, { tenantId: tid, userId: who.sub, deviceId: who.did, action: "sale.rx_missing", entity: "sale", entityId: s.id, data: { sale: s.number, items: rxNames } });
      }
      if (offerMismatch) {
        await audit(tx, {
          tenantId: tid, userId: who.sub, deviceId: who.did, action: "sale.offer_mismatch", entity: "sale", entityId: s.id,
          data: { device: s.lines.map((l) => l.promoMinor), server: expected.promo },
        });
      }
      const manual = s.lines.reduce((a, l) => a + l.discountMinor, 0) + s.invoiceDiscountMinor;
      if (manual > 0) {
        await audit(tx, { tenantId: tid, userId: who.sub, deviceId: who.did, action: "sale.discount", entity: "sale", entityId: s.id, data: { discount: manual } });
        const cashier = (await tx.query(`SELECT name FROM users WHERE id = $1`, [who.sub])).rows[0]?.name ?? "";
        await alertBigDiscount(tx, { tenantId: tid, storeId: who.sid!, discountMinor: manual, number: s.number, cashier });
      }
      await checkLowStock(tx, tid, who.sid!, taken);

      // Loyalty: spend what was paid in points, then earn on the rest. A till that was offline may
      // have spent points the customer no longer had; the sale stands and gets flagged.
      if (customer && s.customerId) {
        const rules = await loyaltySettings(tx, tid);
        if (pointsPaid > 0) {
          await tx.query(`SELECT 1 FROM customers WHERE id = $1 FOR UPDATE`, [s.customerId]);
          const have = await customerPoints(tx, s.customerId);
          const spent = pointsFor(rules, pointsPaid);
          await addPoints(tx, { tenantId: tid, customerId: s.customerId, points: -spent, kind: "redeem", saleId: s.id, userId: who.sub });
          if (spent > have) {
            await audit(tx, { tenantId: tid, userId: who.sub, deviceId: who.did, action: "loyalty.overdrawn", entity: "customer", entityId: s.customerId, data: { sale: s.number, had: have, spent } });
          }
        }
        await addPoints(tx, { tenantId: tid, customerId: s.customerId, points: pointsEarned(rules, totals.total, pointsPaid), kind: "earn", saleId: s.id, userId: who.sub });
      }
    });
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === "23505" && err.constraint === "sales_pkey") return { id: s.id, status: "duplicate" };
    if (err.code === "23505") throw new Reject("رقم الفاتورة مكرر");
    throw e;
  }
  return { id: s.id, status: "accepted" };
}


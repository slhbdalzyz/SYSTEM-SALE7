import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { computeLine, computeTotals, saleInputSchema, type SaleInput } from "@pos/shared";
import { audit, inTx } from "../db";
import { requireDevice } from "../auth";
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
  let customer: { credit_limit_minor: number | null; balance_minor: number } | undefined;
  if (s.customerId) {
    customer = (await app.db.query(
      `SELECT c.credit_limit_minor, b.balance_minor FROM customers c JOIN customer_balances b ON b.customer_id = c.id WHERE c.id = $1 AND c.tenant_id = $2`,
      [s.customerId, tid],
    )).rows[0];
    if (!customer) throw new Reject("العميل غير موجود");
  }
  if (credit > 0 && !customer) throw new Reject("البيع الآجل يحتاج عميل");
  const paid = s.payments.reduce((a, p) => a + p.amountMinor, 0);
  const cash = s.payments.filter((p) => p.method === "cash").reduce((a, p) => a + p.amountMinor, 0);
  if (paid < totals.total) throw new Reject("المدفوع أقل من الإجمالي");
  const change = paid - totals.total;
  if (change > cash) throw new Reject("الباقي ما يكونش أكبر من المدفوع كاش");
  if (credit > totals.total) throw new Reject("الآجل أكبر من الإجمالي");

  const unitIds = [...new Set(s.lines.map((l) => l.unitId))];
  const units = await app.db.query(
    `SELECT u.id, u.product_id, u.factor_milli, u.price_minor, p.cost_minor, p.name
     FROM product_units u JOIN products p ON p.id = u.product_id WHERE u.tenant_id = $1 AND u.id = ANY($2)`,
    [tid, unitIds],
  );
  const byUnit = new Map(units.rows.map((u) => [u.id as string, u]));
  for (const l of s.lines) {
    const u = byUnit.get(l.unitId);
    if (!u || u.product_id !== l.productId) throw new Reject(`الصنف غير موجود: ${l.name}`);
  }

  if (s.shiftId) {
    const sh = await app.db.query(`SELECT 1 FROM shifts WHERE id = $1 AND tenant_id = $2 AND device_id = $3`, [s.shiftId, tid, who.did]);
    if (!sh.rowCount) throw new Reject("الوردية غير موجودة على هذا الجهاز");
  }

  try {
    await inTx(app.db, async (tx) => {
      await tx.query(
        `INSERT INTO sales (id, tenant_id, store_id, device_id, shift_id, user_id, number, subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, change_minor, created_at, customer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [s.id, tid, who.sid, who.did, s.shiftId ?? null, who.sub, s.number, totals.subtotal, totals.discount, totals.tax, totals.total, paid, change, s.createdAt, s.customerId ?? null],
      );
      const overrides: { name: string; catalog: number; sold: number }[] = [];
      for (const l of s.lines) {
        const u = byUnit.get(l.unitId)!;
        const t = computeLine(l);
        const baseQty = Math.round((l.qtyMilli * u.factor_milli) / 1000);
        const cost = Math.round((u.cost_minor * baseQty) / 1000);
        await tx.query(
          `INSERT INTO sale_lines (tenant_id, sale_id, product_id, unit_id, name, qty_milli, price_minor, discount_minor, tax_minor, total_minor, cost_minor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [tid, s.id, l.productId, l.unitId, l.name, l.qtyMilli, l.priceMinor, t.discount, t.tax, t.total, cost],
        );
        await tx.query(
          `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, user_id) VALUES ($1,$2,$3,$4,'sale',$5,$6)`,
          [tid, who.sid, l.productId, -baseQty, s.id, who.sub],
        );
        if (l.priceMinor !== u.price_minor) overrides.push({ name: l.name, catalog: u.price_minor, sold: l.priceMinor });
      }
      for (const p of s.payments) {
        await tx.query(`INSERT INTO payments (tenant_id, sale_id, method, amount_minor) VALUES ($1,$2,$3,$4)`, [tid, s.id, p.method, p.amountMinor]);
      }
      // A price different from the catalog is either an offline device with old prices or a manual override; both are worth a look.
      if (overrides.length) {
        await audit(tx, { tenantId: tid, userId: who.sub, deviceId: who.did, action: "sale.price_mismatch", entity: "sale", entityId: s.id, data: { overrides } });
      }
      // An offline device may have sold on credit past the limit; the sale already happened, so it is kept and flagged.
      if (customer && credit > 0 && customer.credit_limit_minor !== null && customer.balance_minor + credit > customer.credit_limit_minor) {
        await audit(tx, { tenantId: tid, userId: who.sub, deviceId: who.did, action: "customer.over_limit", entity: "customer", entityId: s.customerId!, data: { sale: s.number, balance: customer.balance_minor + credit, limit: customer.credit_limit_minor } });
      }
      if (totals.discount > 0) {
        await audit(tx, { tenantId: tid, userId: who.sub, deviceId: who.did, action: "sale.discount", entity: "sale", entityId: s.id, data: { discount: totals.discount } });
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


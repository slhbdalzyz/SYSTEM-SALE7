import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { refundFor, returnInputSchema } from "@pos/shared";
import { audit, inTx } from "../db";
import { HttpError, authenticate, requireDevice, verifyApproval } from "../auth";

export async function returnRoutes(app: FastifyInstance) {
  async function loadSale(tenantId: string, where: { id?: string; number?: string }) {
    const s = (await app.db.query(
      `SELECT s.id, s.number, s.kind, s.created_at, s.total_minor, s.discount_minor, s.customer_id, c.name AS customer_name, u.name AS cashier
       FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.tenant_id = $1 AND ($2::uuid IS NULL OR s.id = $2) AND ($3::text IS NULL OR s.number = $3)`,
      [tenantId, where.id ?? null, where.number ?? null],
    )).rows[0];
    if (!s) return null;
    const lines = (await app.db.query(
      `SELECT l.id, l.product_id, l.unit_id, l.name, l.qty_milli, l.price_minor, l.discount_minor, l.tax_minor, l.total_minor, l.cost_minor, u.factor_milli,
         COALESCE((SELECT -sum(r.qty_milli) FROM sale_lines r WHERE r.original_line_id = l.id), 0)::bigint AS returned_milli
       FROM sale_lines l JOIN product_units u ON u.id = l.unit_id WHERE l.sale_id = $1 ORDER BY l.id`,
      [s.id],
    )).rows;
    const lineDiscount = lines.reduce((a, l) => a + l.discount_minor, 0);
    const linesNet = lines.reduce((a, l) => a + l.total_minor, 0);
    const payments = (await app.db.query(`SELECT method, amount_minor FROM payments WHERE sale_id = $1`, [s.id])).rows;
    return { ...s, invoice_discount_minor: s.discount_minor - lineDiscount, lines_net_minor: linesNet, lines, payments };
  }

  /** Finds a sale by its invoice number, with how much of each line can still come back. */
  app.get("/sales/lookup", { preHandler: authenticate }, async (req) => {
    const { number } = z.object({ number: z.string().min(1).max(40) }).parse(req.query);
    const s = await loadSale(req.user.tid, { number: number.trim().toUpperCase() });
    if (!s) throw new HttpError(404, "الفاتورة غير موجودة");
    if (s.kind !== "sale") throw new HttpError(400, "هذي فاتورة مرتجع");
    return s;
  });

  app.post("/returns", { preHandler: requireDevice }, async (req) => {
    const who = req.user;
    const b = returnInputSchema.parse(req.body);
    const done = await app.db.query(`SELECT 1 FROM sales WHERE id = $1 AND tenant_id = $2`, [b.id, who.tid]);
    if (done.rowCount) return { id: b.id, status: "duplicate" };

    const approvedBy = who.role === "cashier" ? await verifyApproval(app.db, who.tid, b.approval) : who.sub;
    const orig = await loadSale(who.tid, { id: b.originalSaleId });
    if (!orig || orig.kind !== "sale") throw new HttpError(404, "الفاتورة الأصلية غير موجودة");
    if (b.refundMethod === "credit" && !orig.customer_id) throw new HttpError(400, "الإرجاع على الحساب يحتاج فاتورة عليها عميل");
    if (b.shiftId) {
      const sh = await app.db.query(`SELECT 1 FROM shifts WHERE id = $1 AND tenant_id = $2 AND device_id = $3 AND closed_at IS NULL`, [b.shiftId, who.tid, who.did]);
      if (!sh.rowCount) throw new HttpError(400, "الوردية غير مفتوحة على هذا الجهاز");
    }

    const priced = b.lines.map((r) => {
      const l = orig.lines.find((x: { id: string }) => x.id === r.saleLineId);
      if (!l) throw new HttpError(400, "صنف مش من هذي الفاتورة");
      if (r.qtyMilli > l.qty_milli - l.returned_milli) throw new HttpError(400, `الكمية المرجعة أكبر من المتبقي: ${l.name}`);
      const refund = refundFor(
        { qtyMilli: l.qty_milli, priceMinor: l.price_minor, discountMinor: l.discount_minor, costMinor: l.cost_minor },
        { linesNetMinor: orig.lines_net_minor, invoiceDiscountMinor: orig.invoice_discount_minor },
        r.qtyMilli,
      );
      return { l, qty: r.qtyMilli, ...refund, taxMinor: Math.round((l.tax_minor * r.qtyMilli) / l.qty_milli) };
    });
    const total = priced.reduce((a, p) => a + p.totalMinor, 0);
    const tax = priced.reduce((a, p) => a + p.taxMinor, 0);

    try {
      await inTx(app.db, async (tx) => {
        await tx.query(
          `INSERT INTO sales (id, tenant_id, store_id, device_id, shift_id, user_id, number, subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, change_minor,
             created_at, customer_id, kind, original_sale_id, approved_by, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$8,$8,0,now(),$10,'return',$11,$12,$13)`,
          [b.id, who.tid, who.sid, who.did, b.shiftId ?? null, who.sub, b.number, -total, -tax, orig.customer_id, orig.id, approvedBy, b.reason],
        );
        for (const p of priced) {
          await tx.query(
            `INSERT INTO sale_lines (tenant_id, sale_id, product_id, unit_id, name, qty_milli, price_minor, discount_minor, tax_minor, total_minor, cost_minor, original_line_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11)`,
            [who.tid, b.id, p.l.product_id, p.l.unit_id, p.l.name, -p.qty, p.l.price_minor, -p.taxMinor, -p.totalMinor, -p.costMinor, p.l.id],
          );
          await tx.query(
            `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id) VALUES ($1,$2,$3,$4,'return',$5,$6,$7)`,
            [who.tid, who.sid, p.l.product_id, Math.round((p.qty * p.l.factor_milli) / 1000), b.id, b.reason, who.sub],
          );
        }
        await tx.query(`INSERT INTO payments (tenant_id, sale_id, method, amount_minor) VALUES ($1,$2,$3,$4)`, [who.tid, b.id, b.refundMethod, -total]);
        await audit(tx, {
          tenantId: who.tid, userId: who.sub, deviceId: who.did, action: "sale.return", entity: "sale", entityId: orig.id,
          data: { returnNumber: b.number, original: orig.number, total, method: b.refundMethod, approvedBy, reason: b.reason },
        });
      });
    } catch (e) {
      const err = e as { code?: string; constraint?: string };
      if (err.code === "23505" && err.constraint === "sales_pkey") return { id: b.id, status: "duplicate" };
      if (err.code === "23505") throw new HttpError(409, "رقم الفاتورة مكرر");
      throw e;
    }
    return { id: b.id, status: "accepted", totalMinor: total, lines: priced.map((p) => ({ name: p.l.name, qtyMilli: p.qty, priceMinor: p.l.price_minor, totalMinor: p.totalMinor })) };
  });
}

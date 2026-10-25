import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { offerInputSchema, type Offer, type OfferInput } from "@pos/shared";
import type { Db, Tx } from "../db";
import { audit } from "../db";
import { HttpError, authenticate, requireRole } from "../auth";

const COLS = `id, name, kind, percent_bp, amount_minor, buy_qty, get_qty, bundle_qty, bundle_price_minor, product_ids, category_ids, store_ids,
  starts_at, ends_at, days, hour_from, hour_to, active, updated_at`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toOffer(r: any): Offer & { updatedAt: string } {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: r.id, name: r.name, kind: r.kind, percentBp: n(r.percent_bp), amountMinor: n(r.amount_minor), buyQty: n(r.buy_qty), getQty: n(r.get_qty),
    bundleQty: n(r.bundle_qty), bundlePriceMinor: n(r.bundle_price_minor), productIds: r.product_ids ?? [], categoryIds: r.category_ids ?? [],
    storeIds: r.store_ids ?? [], startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null, endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    days: (r.days ?? []).map(Number), hourFrom: n(r.hour_from), hourTo: n(r.hour_to), active: r.active, updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/** Offers that could still run: switched on and not over. */
export async function currentOffers(q: Db | Tx, tid: string) {
  const r = await q.query(`SELECT ${COLS} FROM offers WHERE tenant_id = $1 AND active AND (ends_at IS NULL OR ends_at > now() - interval '2 days')`, [tid]);
  return r.rows.map(toOffer);
}

function check(b: OfferInput) {
  const need = {
    percent: b.percentBp,
    amount: b.amountMinor,
    buy_get: b.buyQty && b.getQty,
    bundle: b.bundleQty && b.bundlePriceMinor !== null && b.bundlePriceMinor !== undefined,
  }[b.kind];
  if (!need) throw new HttpError(400, "بيانات العرض ناقصة");
  if (b.startsAt && b.endsAt && new Date(b.endsAt) <= new Date(b.startsAt)) throw new HttpError(400, "نهاية العرض قبل بدايته");
}

const values = (b: OfferInput) => [
  b.name, b.kind, b.kind === "percent" ? b.percentBp : null, b.kind === "amount" ? b.amountMinor : null,
  b.kind === "buy_get" ? b.buyQty : null, b.kind === "buy_get" ? b.getQty : null,
  b.kind === "bundle" ? b.bundleQty : null, b.kind === "bundle" ? b.bundlePriceMinor : null,
  b.productIds, b.categoryIds, b.storeIds, b.startsAt ?? null, b.endsAt ?? null, b.days, b.hourFrom ?? null, b.hourTo ?? null, b.active,
];

export async function offerRoutes(app: FastifyInstance) {
  const managers = { preHandler: requireRole("owner", "manager") };

  /** All offers, with how much each one has given away so far. */
  app.get("/offers", managers, async (req) => {
    const r = await app.db.query(
      `SELECT ${COLS},
              (SELECT count(DISTINCT l.sale_id)::int FROM sale_lines l WHERE l.offer_id = o.id) AS sales_count,
              (SELECT COALESCE(sum(l.promo_minor), 0)::bigint FROM sale_lines l WHERE l.offer_id = o.id) AS given_minor
       FROM offers o WHERE tenant_id = $1 ORDER BY active DESC, created_at DESC`,
      [req.user.tid],
    );
    return r.rows.map((row) => ({ ...toOffer(row), salesCount: row.sales_count, givenMinor: Number(row.given_minor) }));
  });

  app.post("/offers", managers, async (req) => {
    const b = offerInputSchema.parse(req.body);
    check(b);
    const r = await app.db.query(
      `INSERT INTO offers (tenant_id, name, kind, percent_bp, amount_minor, buy_qty, get_qty, bundle_qty, bundle_price_minor, product_ids, category_ids, store_ids,
         starts_at, ends_at, days, hour_from, hour_to, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [req.user.tid, ...values(b)],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "offer.create", entity: "offer", entityId: r.rows[0].id, data: { name: b.name, kind: b.kind } });
    return { id: r.rows[0].id };
  });

  app.put("/offers/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = offerInputSchema.parse(req.body);
    check(b);
    const r = await app.db.query(
      `UPDATE offers SET name = $3, kind = $4, percent_bp = $5, amount_minor = $6, buy_qty = $7, get_qty = $8, bundle_qty = $9, bundle_price_minor = $10,
         product_ids = $11, category_ids = $12, store_ids = $13, starts_at = $14, ends_at = $15, days = $16, hour_from = $17, hour_to = $18, active = $19, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tid, ...values(b)],
    );
    if (!r.rowCount) throw new HttpError(404, "العرض غير موجود");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "offer.update", entity: "offer", entityId: id, data: { active: b.active } });
    return { ok: true };
  });

  /** What a cashier device keeps for working offline. */
  app.get("/sync/offers", { preHandler: authenticate }, async (req) => {
    const list = await currentOffers(app.db, req.user.tid);
    return list.filter((o) => !req.user.sid || !o.storeIds.length || o.storeIds.includes(req.user.sid));
  });
}

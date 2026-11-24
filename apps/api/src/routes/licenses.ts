// The platform's side of desktop licences: issue a yearly key for a shop's computer, renew it,
// revoke it. The signing key is made once and kept in the database (or LICENSE_PRIVATE_KEY and
// LICENSE_PUBLIC_KEY); the Windows build fetches the public half from GET /licenses/public-key.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, platformGuard } from "../auth";
import type { Db } from "../db";
import { newKeyPair, normalizeMachineId, signLicense, type LicensePayload } from "../license";
import { DEFAULT_LICENSE_PLANS, quoteLicense, upgradePrice, type LicensePlans } from "@pos/shared";

/** The packages the platform sells the desktop app in (set on «تراخيص سطح المكتب»). */
export async function licensePlans(db: Db): Promise<LicensePlans> {
  const v = (await db.query(`SELECT value FROM platform_settings WHERE key = 'license_plans'`)).rows[0]?.value as Partial<LicensePlans> | undefined;
  return { ...DEFAULT_LICENSE_PLANS, ...(v ?? {}) };
}

const plansSchema = z.object({
  plans: z.array(z.object({
    id: z.string().trim().regex(/^[a-z0-9_-]{1,20}$/),
    name: z.string().trim().min(1).max(40),
    devices: z.number().int().min(1).max(50),
    priceMinor: z.number().int().min(0).max(1e10),
  })).min(1).max(10),
  extraDeviceMinor: z.number().int().min(0).max(1e10),
  yearDiscounts: z.record(z.string().regex(/^[2-5]$/), z.number().min(0).max(90)),
  sellerPhone: z.string().trim().max(30).nullable(),
});

export async function licenseKeys(db: Db): Promise<{ publicKey: string; privateKey: string }> {
  if (process.env.LICENSE_PRIVATE_KEY && process.env.LICENSE_PUBLIC_KEY) return { publicKey: process.env.LICENSE_PUBLIC_KEY, privateKey: process.env.LICENSE_PRIVATE_KEY };
  const read = async () => (await db.query(`SELECT value FROM platform_settings WHERE key = 'license_keys'`)).rows[0]?.value as { publicKey: string; privateKey: string } | undefined;
  const saved = await read();
  if (saved?.publicKey) return saved;
  // Two servers at once: the first one's pair wins, the other reads it back.
  await db.query(`INSERT INTO platform_settings (key, value) VALUES ('license_keys', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(newKeyPair())]);
  return (await read())!;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function licenseRoutes(app: FastifyInstance) {
  const g = { preHandler: platformGuard("payments") };

  /** Public: the Windows build puts it in the app, so the app can check keys offline. */
  app.get("/licenses/public-key", async () => ({ publicKey: (await licenseKeys(app.db)).publicKey }));

  /** Public: a shop's app, when online, asks for its newest key (a renewal the platform issued). */
  app.get("/licenses/:id/latest", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { machine } = z.object({ machine: z.string().max(40) }).parse(req.query);
    const r = await app.db.query(
      `SELECT key FROM desktop_licenses WHERE root_id = (SELECT root_id FROM desktop_licenses WHERE id = $1) AND machine_id = $2 AND NOT revoked ORDER BY valid_until DESC, created_at DESC LIMIT 1`,
      [id, normalizeMachineId(machine)],
    );
    if (!r.rowCount) throw new HttpError(404, "غير موجود");
    return { key: r.rows[0].key };
  });

  /** Public: the shop's app, when online, shows the packages and where to ask for a bigger one. */
  app.get("/licenses/plans", async () => licensePlans(app.db));

  app.get("/platform/license-plans", g, async () => licensePlans(app.db));
  app.put("/platform/license-plans", g, async (req) => {
    const b = plansSchema.parse(req.body);
    if (new Set(b.plans.map((p) => p.id)).size !== b.plans.length) throw new HttpError(400, "كل باقة لازم يكون رمزها مختلف");
    await app.db.query(
      `INSERT INTO platform_settings (key, value) VALUES ('license_plans', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(b)],
    );
    return b;
  });

  app.get("/platform/licenses", g, async () => {
    const r = await app.db.query(
      `SELECT l.id, l.root_id, l.shop_name, l.phone, l.machine_id, l.valid_from, l.valid_until, l.devices, l.amount_minor, l.note, l.plan, l.extra_devices, l.annual_minor, l.upgrade_of, l.key, l.revoked, l.created_at, a.name AS created_by_name,
              l.valid_until = max(l.valid_until) OVER (PARTITION BY l.root_id) AS latest
       FROM desktop_licenses l LEFT JOIN platform_admins a ON a.id = l.created_by ORDER BY l.created_at DESC LIMIT 500`,
    );
    return r.rows;
  });

  /** A new licence, or with renewOf the next year of one (starting the day after it ends, or today). */
  app.post("/platform/licenses", g, async (req) => {
    const b = z
      .object({
        shopName: z.string().trim().min(2).max(120),
        phone: z.string().trim().max(40).optional(),
        machineId: z.string().trim().max(40),
        years: z.number().int().min(1).max(5).default(1),
        devices: z.number().int().min(1).max(50).default(1),
        /** A package: its tills plus `extraDevices`, and its price unless `amountMinor` says otherwise. */
        plan: z.string().max(20).optional(),
        extraDevices: z.number().int().min(0).max(45).default(0),
        amountMinor: z.number().int().min(0).optional(),
        note: z.string().trim().max(500).optional(),
        renewOf: z.string().uuid().optional(),
      })
      .parse(req.body);
    const machine = normalizeMachineId(b.machineId);
    if (!/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(machine)) throw new HttpError(400, "رقم الجهاز لازم يكون 16 حرف ورقم، مثل 1A2B-3C4D-5E6F-7A8B");
    let root: string | null = null;
    let from = new Date();
    if (b.renewOf) {
      const prev = (await app.db.query(`SELECT root_id, max(valid_until) OVER (PARTITION BY root_id) AS last FROM desktop_licenses WHERE id = $1`, [b.renewOf])).rows[0];
      if (!prev) throw new HttpError(404, "الترخيص غير موجود");
      root = prev.root_id;
      const next = new Date(`${prev.last}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      if (next > from) from = next;
    }
    const until = new Date(from);
    until.setUTCFullYear(until.getUTCFullYear() + b.years);
    until.setUTCDate(until.getUTCDate() - 1);
    const plans = await licensePlans(app.db);
    const q = b.plan ? quoteLicense(plans, { planId: b.plan, extra: b.extraDevices, years: b.years }) : null;
    if (b.plan && !q!.plan) throw new HttpError(400, "الباقة غير موجودة");
    const devices = q ? q.devices : b.devices;
    const amount = b.amountMinor ?? q?.totalMinor ?? 0;
    return issue({
      root, shop: b.shopName, phone: b.phone ?? null, machine, from: day(from), until: day(until), devices, amount, note: b.note ?? null,
      plan: q?.plan ?? null, extra: q ? b.extraDevices : 0, annual: q ? q.annualMinor : Math.round(amount / b.years), upgradeOf: null, by: req.platform!.id,
    });
  });

  /** Signs and records one key. */
  async function issue(a: {
    root: string | null; shop: string; phone: string | null; machine: string; from: string; until: string; devices: number; amount: number; note: string | null;
    plan: { id: string; name: string } | null; extra: number; annual: number; upgradeOf: string | null; by: string;
  }) {
    const id = (await app.db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
    const payload: LicensePayload = {
      v: 1, id, root: a.root ?? id, shop: a.shop, machine: a.machine, from: a.from, until: a.until, devices: a.devices, issued: new Date().toISOString(),
      ...(a.plan ? { plan: a.plan.name } : {}),
    };
    const key = signLicense(payload, (await licenseKeys(app.db)).privateKey);
    await app.db.query(
      `INSERT INTO desktop_licenses (id, root_id, shop_name, phone, machine_id, valid_from, valid_until, devices, amount_minor, note, key, created_by, plan, extra_devices, annual_minor, upgrade_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, payload.root, a.shop, a.phone, a.machine, a.from, a.until, a.devices, a.amount, a.note, key, a.by, a.plan?.id ?? null, a.extra, a.annual, a.upgradeOf],
    );
    return { id, key, validFrom: a.from, validUntil: a.until, devices: a.devices, amountMinor: a.amount };
  }

  /**
   * A bigger package mid-year: a new key for the same computer with more tills, to the same last
   * day. The price is the yearly difference for the days left (unless `amountMinor` says otherwise).
   */
  app.post("/platform/licenses/:id/upgrade", g, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ plan: z.string().max(20), extraDevices: z.number().int().min(0).max(45).default(0), amountMinor: z.number().int().min(0).optional(), note: z.string().trim().max(500).optional() }).parse(req.body);
    const cur = (await app.db.query(
      `SELECT l.*, l.valid_until = max(l.valid_until) OVER (PARTITION BY l.root_id) AS latest FROM desktop_licenses l
       WHERE l.root_id = (SELECT root_id FROM desktop_licenses WHERE id = $1) AND NOT l.revoked ORDER BY l.valid_until DESC, l.created_at DESC LIMIT 1`,
      [id],
    )).rows[0];
    if (!cur) throw new HttpError(404, "الترخيص غير موجود");
    const today = day(new Date());
    const until = day(new Date(cur.valid_until));
    if (until < today) throw new HttpError(400, "الترخيص منتهي: جدّده بالباقة الجديدة بدل الترقية");
    const q = quoteLicense(await licensePlans(app.db), { planId: b.plan, extra: b.extraDevices, years: 1 });
    if (!q.plan) throw new HttpError(400, "الباقة غير موجودة");
    if (q.devices <= cur.devices) throw new HttpError(400, `الترخيص الحالي فيه ${cur.devices} أجهزة. اختار باقة أكبر`);
    const oldAnnual = Number(cur.annual_minor ?? cur.amount_minor ?? 0);
    const price = upgradePrice({ oldAnnualMinor: oldAnnual, newAnnualMinor: q.annualMinor, today, until });
    const from = day(new Date(cur.valid_from)) > today ? day(new Date(cur.valid_from)) : today;
    return {
      ...(await issue({
        root: cur.root_id, shop: cur.shop_name, phone: cur.phone, machine: cur.machine_id, from, until, devices: q.devices, amount: b.amountMinor ?? price.totalMinor,
        note: b.note ?? `ترقية لباقة ${q.plan.name} (${price.days} يوم)`, plan: q.plan, extra: b.extraDevices, annual: q.annualMinor, upgradeOf: cur.id, by: req.platform!.id,
      })),
      days: price.days,
    };
  });

  app.post("/platform/licenses/:id/revoke", g, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await app.db.query(`UPDATE desktop_licenses SET revoked = true WHERE id = $1`, [id]);
    return { ok: true };
  });
}

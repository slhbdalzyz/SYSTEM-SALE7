// The platform's side of desktop licences: issue a yearly key for a shop's computer, renew it,
// revoke it. The signing key is made once and kept in the database (or LICENSE_PRIVATE_KEY and
// LICENSE_PUBLIC_KEY); the Windows build fetches the public half from GET /licenses/public-key.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, platformGuard } from "../auth";
import type { Db } from "../db";
import { newKeyPair, normalizeMachineId, signLicense, type LicensePayload } from "../license";

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

  app.get("/platform/licenses", g, async () => {
    const r = await app.db.query(
      `SELECT l.id, l.root_id, l.shop_name, l.phone, l.machine_id, l.valid_from, l.valid_until, l.devices, l.amount_minor, l.note, l.key, l.revoked, l.created_at, a.name AS created_by_name,
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
        amountMinor: z.number().int().min(0).default(0),
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
    const id = (await app.db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
    const payload: LicensePayload = { v: 1, id, root: root ?? id, shop: b.shopName, machine, from: day(from), until: day(until), devices: b.devices, issued: new Date().toISOString() };
    const key = signLicense(payload, (await licenseKeys(app.db)).privateKey);
    await app.db.query(
      `INSERT INTO desktop_licenses (id, root_id, shop_name, phone, machine_id, valid_from, valid_until, devices, amount_minor, note, key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, payload.root, b.shopName, b.phone ?? null, machine, payload.from, payload.until, b.devices, b.amountMinor, b.note ?? null, key, req.platform!.id],
    );
    return { id, key, validFrom: payload.from, validUntil: payload.until };
  });

  app.post("/platform/licenses/:id/revoke", g, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await app.db.query(`UPDATE desktop_licenses SET revoked = true WHERE id = $1`, [id]);
    return { ok: true };
  });
}

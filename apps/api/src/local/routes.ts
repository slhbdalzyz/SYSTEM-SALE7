// Routes that exist only in the local edition.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { audit } from "../db";
import { authenticate, HttpError, requireRole } from "../auth";
import type { LocalBackups } from "./backup";
import type { LocalLicense } from "./license";
import { daysLeft, graceDays, subState } from "../billing";

export interface LocalOptions {
  shutdownToken: string;
  stop: () => void;
  backups?: LocalBackups;
  restore?: (file: Buffer, password: string | null) => Promise<void>;
  license?: LocalLicense;
  network?: { get: () => { lan: boolean; port: number; addresses: string[]; web: boolean }; set: (lan: boolean) => Promise<void> };
}

const MAX_BACKUP = 2 * 1024 * 1024 * 1024;

export async function localRoutes(app: FastifyInstance, opts: LocalOptions) {
  const shopExists = async () => !!(await app.db.query(`SELECT 1 FROM tenants LIMIT 1`)).rowCount;

  /** What the first screen needs: is there a shop on this computer yet, or is this the first run. */
  app.get("/local/status", async () => {
    const t = (await app.db.query(`SELECT id, name FROM tenants ORDER BY created_at LIMIT 1`)).rows[0] as { id: string; name: string } | undefined;
    // The id lets the app tell this shop's till data from another's (an old install, the demo).
    return { edition: "local", shop: t ? { id: t.id, name: t.name } : null };
  });

  /** The Windows app asks for a clean stop when it closes, so the database is never cut off mid-write. */
  app.post("/local/shutdown", async (req, reply) => {
    const got = Buffer.from(String(req.headers["x-shutdown-token"] ?? ""));
    const want = Buffer.from(opts.shutdownToken);
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return reply.status(403).send({ error: "ممنوع" });
    setTimeout(opts.stop, 50);
    return { ok: true };
  });

  const license = opts.license;
  if (license) {
    /** The licence screen: this computer's ID (to send to the seller), the key in use, and where it stands. */
    app.get("/local/license", { preHandler: authenticate }, async (req) => {
      const t = (await app.db.query(`SELECT status, paid_until, status_reason FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
      const cur = license.current();
      return {
        machineId: license.machineId,
        canActivate: license.publicKeys.length > 0,
        license: cur ? { shop: cur.shop, from: cur.from, until: cur.until, devices: cur.devices } : null,
        state: t ? subState(t, await graceDays(app.db)) : "locked",
        paidUntil: t?.paid_until ?? null,
        daysLeft: t ? daysLeft(t.paid_until) : 0,
        reason: t?.status_reason ?? null,
      };
    });

    app.post("/local/license", { preHandler: requireRole("owner") }, async (req) => {
      const { key } = z.object({ key: z.string().min(10).max(4000) }).parse(req.body);
      const p = license.activate(key);
      await license.apply(app.db);
      await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "license.activate", data: { id: p.id, until: p.until } });
      return { ok: true, until: p.until };
    });
  }

  const network = opts.network;
  if (network) {
    /** Shop network: whether it is on, and the addresses the other devices open. */
    app.get("/local/network", { preHandler: requireRole("owner", "manager") }, async () => network.get());
    app.put("/local/network", { preHandler: requireRole("owner") }, async (req) => {
      const { lan } = z.object({ lan: z.boolean() }).parse(req.body);
      // Answer first: the server stops listening for a moment while it moves to the new address.
      setTimeout(() => void network.set(lan).catch((e) => console.error("shop network", e)), 150);
      await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: lan ? "network.on" : "network.off" });
      return { ok: true };
    });
  }

  const backups = opts.backups;
  const restore = opts.restore;
  if (!backups || !restore) return;
  const owner = requireRole("owner");

  /** The backup screen: when the last one was made, where they go, and the files there. */
  app.get("/local/backup", { preHandler: owner }, async () => {
    const s = backups.settings;
    return { lastAt: s.lastAt, lastName: s.lastName, lastError: s.lastError, extraError: s.extraError, dir: backups.dir, extraDir: s.extraDir, encrypted: !!s.key, running: !!backups.running, warning: backups.warning(), files: backups.list() };
  });

  /** Just the warning, for the banner on the owner's screens. */
  app.get("/local/backup/warning", { preHandler: owner }, async () => ({ warning: backups.warning() }));

  app.post("/local/backup", { preHandler: owner }, async (req) => {
    const name = await backups.run();
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "backup.local", data: { name } });
    return { name };
  });

  app.put("/local/backup/settings", { preHandler: owner }, async (req) => {
    const b = z.object({ extraDir: z.string().max(400).nullable().optional(), password: z.string().min(6).max(200).nullable().optional() }).parse(req.body);
    if (b.extraDir !== undefined) backups.setExtraDir(b.extraDir);
    if (b.password !== undefined) backups.setPassword(b.password);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "backup.settings", data: { extraDir: backups.settings.extraDir, encrypted: !!backups.settings.key } });
    return { ok: true };
  });

  /** Restoring a file from the list, by its name. */
  app.post("/local/restore/:where/:name", { preHandler: owner }, async (req) => {
    const p = z.object({ where: z.enum(["local", "extra"]), name: z.string().max(80) }).parse(req.params);
    const b = z.object({ password: z.string().max(200).optional() }).parse(req.body ?? {});
    await restore(backups.read(p.name, p.where), b.password || null);
    return { ok: true };
  });

  // A file the owner brings (from a USB stick, or on a new computer before any shop exists).
  app.register(async (raw) => {
    raw.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_BACKUP }, (_req, body, done) => done(null, body));
    raw.post("/local/restore", { bodyLimit: MAX_BACKUP }, async (req) => {
      // On the first run there is nobody to sign in yet; after that only the owner restores.
      if (await shopExists()) await ownerOnly(req);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, "اختار ملف النسخة");
      const password = req.headers["x-backup-password"] ? decodeURIComponent(String(req.headers["x-backup-password"])) : null;
      await restore(req.body, password);
      return { ok: true };
    });
  });

  async function ownerOnly(req: FastifyRequest) {
    await authenticate(req);
    if (req.user.role !== "owner") throw new HttpError(403, "ليس لديك صلاحية");
  }
}

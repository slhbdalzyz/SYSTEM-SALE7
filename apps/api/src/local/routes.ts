// Routes that exist only in the local edition.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { audit } from "../db";
import { authenticate, HttpError, requireRole } from "../auth";
import type { LocalBackups } from "./backup";

export interface LocalOptions {
  shutdownToken: string;
  stop: () => void;
  backups?: LocalBackups;
  restore?: (file: Buffer, password: string | null) => Promise<void>;
}

const MAX_BACKUP = 2 * 1024 * 1024 * 1024;

export async function localRoutes(app: FastifyInstance, opts: LocalOptions) {
  const shopExists = async () => !!(await app.db.query(`SELECT 1 FROM tenants LIMIT 1`)).rowCount;

  /** What the first screen needs: is there a shop on this computer yet, or is this the first run. */
  app.get("/local/status", async () => {
    const t = (await app.db.query(`SELECT name FROM tenants ORDER BY created_at LIMIT 1`)).rows[0] as { name: string } | undefined;
    return { edition: "local", shop: t ? { name: t.name } : null };
  });

  /** The Windows app asks for a clean stop when it closes, so the database is never cut off mid-write. */
  app.post("/local/shutdown", async (req, reply) => {
    const got = Buffer.from(String(req.headers["x-shutdown-token"] ?? ""));
    const want = Buffer.from(opts.shutdownToken);
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return reply.status(403).send({ error: "ممنوع" });
    setTimeout(opts.stop, 50);
    return { ok: true };
  });

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

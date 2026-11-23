// Routes that exist only in the local edition.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { audit, inTx } from "../db";
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

/** What "clear the records" empties: everything that happened, none of how the shop is set up. */
const ACTIVITY = [
  "sale_lines", "payments", "kitchen_tickets", "coupon_redemptions", "loyalty_entries", "sales", "drawer_moves", "shifts",
  "purchase_lines", "purchase_invoices", "customer_payments", "supplier_payments", "stock_movements",
  "stock_count_lines", "stock_counts", "stock_transfer_lines", "stock_transfers", "breakdown_lines", "breakdowns", "product_serials",
  "money_cleared", "money_movements", "bank_reconciliations", "expenses", "payroll_entries", "payroll_months",
  "quotes", "repairs", "installment_plans", "zakat_reports", "alerts", "audit_log", "ai_usage",
];

const MAX_BACKUP = 2 * 1024 * 1024 * 1024;

export async function localRoutes(app: FastifyInstance, opts: LocalOptions) {
  const shopExists = async () => !!(await app.db.query(`SELECT 1 FROM tenants LIMIT 1`)).rowCount;

  /** What the first screen needs: is there a shop on this computer yet, or is this the first run. */
  app.get("/local/status", async () => {
    const t = (await app.db.query(`SELECT id, name, settings->>'resetAt' AS reset_at FROM tenants ORDER BY created_at LIMIT 1`)).rows[0] as { id: string; name: string; reset_at: string | null } | undefined;
    // The id lets the app tell this shop's till data from another's (an old install, the demo);
    // resetAt tells it the shop's records were cleared, so its own copy of them is old.
    return { edition: "local", shop: t ? { id: t.id, name: t.name, resetAt: t.reset_at } : null };
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

  /**
   * Clearing the database. "activity" keeps the shop as it is set up (items, customers, suppliers,
   * staff, devices, settings) and drops every record of what happened: sales, purchases, stock,
   * money, debts, shifts. "all" drops the shop itself: the app opens on the first-run setup again.
   * A backup is made first, so either can be undone from the list.
   */
  app.post("/local/reset", { preHandler: owner }, async (req) => {
    const b = z.object({ mode: z.enum(["activity", "all"]), password: z.string().min(1).max(200) }).parse(req.body);
    const u = (await app.db.query(`SELECT password_hash FROM users WHERE id = $1 AND tenant_id = $2`, [req.user.sub, req.user.tid])).rows[0];
    if (!u?.password_hash || !(await bcrypt.compare(b.password, u.password_hash))) throw new HttpError(403, "كلمة السر غلط");
    const backup = await backups.run();
    if (b.mode === "all") {
      // One shop per computer: every table of the shop hangs off its row.
      await app.db.query(`TRUNCATE tenants CASCADE`);
    } else {
      await inTx(app.db, async (tx) => {
        await tx.query(`TRUNCATE ${ACTIVITY.join(", ")}`);
        await tx.query(`UPDATE customers SET opening_balance_minor = 0`);
        await tx.query(`UPDATE suppliers SET opening_balance_minor = 0`);
        await tx.query(`UPDATE tenants SET settings = settings || jsonb_build_object('resetAt', now()::text)`);
      });
      await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "local.reset", data: { mode: b.mode, backup } });
    }
    return { ok: true, backup };
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

import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import type { Db } from "./db";
import { HttpError, type TokenPayload } from "./auth";
import { authRoutes } from "./routes/auth";
import { adminRoutes } from "./routes/admin";
import { catalogRoutes } from "./routes/catalog";
import { salesRoutes } from "./routes/sales";
import { shiftRoutes } from "./routes/shifts";
import { stockRoutes } from "./routes/stock";
import { reportRoutes } from "./routes/reports";
import { customerRoutes } from "./routes/customers";
import { returnRoutes } from "./routes/returns";
import { deviceRoutes } from "./routes/devices";
import { platformRoutes } from "./routes/platform";
import { purchasingRoutes } from "./routes/purchasing";
import { branchRoutes } from "./routes/branches";
import { offerRoutes } from "./routes/offers";
import { subscriptionRoutes } from "./routes/subscription";
import { ownerRoutes } from "./routes/owner";
import { payrollRoutes } from "./routes/payroll";
import { moneyRoutes } from "./routes/money";
import { settingsRoutes } from "./routes/settings";
import { invoiceRoutes } from "./routes/invoices";
import { restoreRoutes } from "./routes/restore";
import { countRoutes } from "./routes/counts";
import { zakatRoutes } from "./routes/zakat";
import { loyaltyRoutes } from "./routes/loyalty";
import { quickRoutes } from "./routes/quick";
import { importRoutes } from "./routes/import";
import { subscriptionGuard } from "./billing";
import { checkTokenRules } from "./features";
import { platformProRoutes, runReminders } from "./routes/platform-pro";
import { supportRoutes } from "./routes/support";
import { butcherRoutes } from "./routes/butcher";
import { restaurantRoutes } from "./routes/restaurant";
import { setGateway, type Gateway } from "./payments/gateway";
import { plutuFromEnv } from "./payments/plutu";
import { fakeGateway } from "./payments/fake";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  corsOrigin?: string | string[];
  logger?: boolean;
  /** Behind a proxy or a platform like Vercel: take the client IP from X-Forwarded-For (rate limits). */
  trustProxy?: boolean;
  /** Online subscription payments. Default: Plutu when its keys are in the environment, the demo stand-in with PAYMENTS_FAKE=1, else none. */
  gateway?: Gateway | null;
}

export async function buildApp(opts: AppOptions) {
  if (opts.jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false, bodyLimit: 2 * 1024 * 1024 });
  app.decorate("db", opts.db);
  setGateway(opts.gateway !== undefined ? opts.gateway : (plutuFromEnv() ?? (process.env.PAYMENTS_FAKE === "1" ? fakeGateway() : null)));

  await app.register(helmet);
  await app.register(cors, { origin: opts.corsOrigin ?? true });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  await app.register(jwt, { secret: opts.jwtSecret });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "بيانات غير صحيحة", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error(err);
    // Keep a copy for the platform's error page; never let logging itself break the reply.
    const e = err as Error;
    app.db.query(
      `INSERT INTO server_errors (method, url, tenant_id, message, stack) VALUES ($1,$2,$3,$4,$5)`,
      [req.method, req.url.slice(0, 500), (req.user as { tid?: string } | undefined)?.tid ?? null, String(e?.message ?? err).slice(0, 2000), String(e?.stack ?? "").slice(0, 8000)],
    ).catch(() => {});
    return reply.status(500).send({ error: "خطأ في السيرفر" });
  });

  app.get("/health", async (_req, reply) => {
    // Also checks the database, so an uptime monitor sees a dead database, not just a live process.
    const t = Date.now();
    try {
      await app.db.query("SELECT 1");
      return { ok: true, db: true, dbMs: Date.now() - t };
    } catch {
      return reply.status(503).send({ ok: false, db: false });
    }
  });
  subscriptionGuard(app);
  // Renewal reminders, about once an hour, carried by whatever request comes in (serverless has no timer).
  let remindCheckedAt = 0;
  app.addHook("onRequest", async () => {
    if (Date.now() - remindCheckedAt < 10 * 60_000) return;
    remindCheckedAt = Date.now();
    const due = await opts.db.query(
      `INSERT INTO platform_settings (key, value) VALUES ('reminders_last_run', to_jsonb(now()))
       ON CONFLICT (key) DO UPDATE SET value = to_jsonb(now()) WHERE (platform_settings.value #>> '{}')::timestamptz < now() - interval '1 hour'
       RETURNING 1`,
    ).catch(() => ({ rowCount: 0 }));
    if (due.rowCount) await runReminders(opts.db).catch((e) => app.log.error(e, "reminders"));
  });
  // A support session only looks; features the platform closed stay closed.
  app.addHook("preHandler", async (req) => {
    if (!req.headers.authorization) return;
    await checkTokenRules(opts.db, req.method, req.url, () => req.jwtVerify<TokenPayload>());
  });
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.register(salesRoutes);
  await app.register(shiftRoutes);
  await app.register(stockRoutes);
  await app.register(reportRoutes);
  await app.register(customerRoutes);
  await app.register(returnRoutes);
  await app.register(deviceRoutes);
  await app.register(platformRoutes);
  await app.register(platformProRoutes);
  await app.register(supportRoutes);
  await app.register(butcherRoutes);
  await app.register(restaurantRoutes);
  await app.register(purchasingRoutes);
  await app.register(branchRoutes);
  await app.register(offerRoutes);
  await app.register(subscriptionRoutes);
  await app.register(ownerRoutes);
  await app.register(restoreRoutes);
  await app.register(payrollRoutes);
  await app.register(moneyRoutes);
  await app.register(settingsRoutes);
  await app.register(invoiceRoutes);
  await app.register(countRoutes);
  await app.register(zakatRoutes);
  await app.register(loyaltyRoutes);
  await app.register(quickRoutes);
  await app.register(importRoutes);
  return app;
}


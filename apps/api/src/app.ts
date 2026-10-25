import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import type { Db } from "./db";
import { HttpError } from "./auth";
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
import { subscriptionGuard } from "./billing";

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
}

export async function buildApp(opts: AppOptions) {
  if (opts.jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false, bodyLimit: 2 * 1024 * 1024 });
  app.decorate("db", opts.db);

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
    return reply.status(500).send({ error: "خطأ في السيرفر" });
  });

  app.get("/health", async () => ({ ok: true }));
  subscriptionGuard(app);
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
  await app.register(purchasingRoutes);
  await app.register(branchRoutes);
  await app.register(offerRoutes);
  await app.register(subscriptionRoutes);
  return app;
}

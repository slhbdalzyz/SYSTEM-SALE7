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
}

export async function buildApp(opts: AppOptions) {
  if (opts.jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
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
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.register(salesRoutes);
  await app.register(shiftRoutes);
  await app.register(stockRoutes);
  await app.register(reportRoutes);
  await app.register(customerRoutes);
  await app.register(returnRoutes);
  return app;
}

import { buildApp } from "./app";
import { createPool } from "./db";
import { bootstrapPlatformAdmin, migrate } from "./migrate";
import { setupPush } from "./push";

const db = createPool();
await migrate(db);
await bootstrapPlatformAdmin(db);
await setupPush(db);
const secret = process.env.JWT_SECRET ?? (process.env.NODE_ENV === "production" ? "" : "dev-only-secret-change-me-0123456789abcdef");
const app = await buildApp({
  db,
  jwtSecret: secret,
  corsOrigin: process.env.CORS_ORIGIN?.split(","),
  logger: true,
  trustProxy: process.env.TRUST_PROXY === "1",
});
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

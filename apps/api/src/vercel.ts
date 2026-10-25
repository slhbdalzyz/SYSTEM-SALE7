// The API as one Vercel serverless function. Each instance keeps a small pool to the
// database's connection pooler and reuses the app between requests.
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "./app";
import { createPool } from "./db";
import { setupPush } from "./push";

const secret = process.env.JWT_SECRET ?? "";
const ready = (async () => {
  const db = createPool(process.env.DATABASE_URL ?? process.env.POSTGRES_URL, 3);
  await setupPush(db);
  const app = await buildApp({
    db,
    jwtSecret: secret,
    corsOrigin: process.env.CORS_ORIGIN?.split(","),
    trustProxy: true,
  });
  await app.ready();
  return app;
})();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  // The web app calls /api/...; the routes themselves have no prefix.
  req.url = (req.url ?? "/").replace(/^\/api(?=\/|$|\?)/, "") || "/";
  app.server.emit("request", req, res);
}

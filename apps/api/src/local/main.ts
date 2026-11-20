// The local edition's server: the same API as the cloud, for one shop, on the shop's own computer.
// The Windows app starts it in the background with its own Node, and the till talks to it on
// http://127.0.0.1:7400. The database is PGlite in a folder on the disk, so nothing needs the internet.
//
//   POS_DATA_DIR   where the shop's data lives (required)
//   PORT, HOST     default 7400 on 127.0.0.1 (this computer only)
//   POS_PARENT_PID the app that started it: when that is gone, this closes the database and stops
//   POS_SHUTDOWN_TOKEN  lets the app ask for a clean stop on POST /api/local/shutdown
process.env.POS_LOCAL = "1";

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../app";
import type { Db } from "../db";
import { PgliteDb, pgliteParsers } from "../pglite-db";
import { localRoutes } from "./routes";

const dataDir = process.env.POS_DATA_DIR;
if (!dataDir) {
  console.error("POS_DATA_DIR is required");
  process.exit(2);
}
const port = Number(process.env.PORT ?? 7400);
const host = process.env.HOST ?? "127.0.0.1";
mkdirSync(dataDir, { recursive: true });

// Two copies of PostgreSQL writing the same folder would ruin it: only one server per folder.
const lockFile = path.join(dataDir, "server.lock");
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
if (existsSync(lockFile)) {
  const pid = Number(readFileSync(lockFile, "utf8"));
  if (pid && pid !== process.pid && alive(pid)) {
    console.error(`another server (pid ${pid}) is using ${dataDir}`);
    process.exit(3);
  }
}
writeFileSync(lockFile, String(process.pid));

// The key that signs sign-ins, made once per computer and kept with the data.
const secretFile = path.join(dataDir, "secret.key");
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(48).toString("hex"), { mode: 0o600 });
const jwtSecret = readFileSync(secretFile, "utf8").trim();

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = [process.env.POS_MIGRATIONS_DIR, path.join(here, "migrations"), path.join(here, "..", "..", "migrations")].find((d) => d && existsSync(d))!;

const pg = await PGlite.create(path.join(dataDir, "db"), { parsers: pgliteParsers });
await migrate(pg, migrationsDir);
const db = new PgliteDb(pg);

const shutdownToken = process.env.POS_SHUTDOWN_TOKEN ?? "";
const app = await buildApp({ db: db as unknown as Db, jwtSecret, logger: false });
await app.register(localRoutes, { shutdownToken, stop: () => void stop("asked") });

let stopping = false;
let server: Server | undefined;
async function stop(why: string) {
  if (stopping) return;
  stopping = true;
  console.log(`stopping (${why})`);
  const hard = setTimeout(() => process.exit(1), 8000);
  hard.unref();
  server?.close();
  await app.close().catch(() => undefined);
  await db.idle().catch(() => undefined);
  await pg.close().catch(() => undefined);
  rmSync(lockFile, { force: true });
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

const parent = Number(process.env.POS_PARENT_PID ?? 0);
if (parent) setInterval(() => !alive(parent) && void stop("app closed"), 2000).unref();

// The API answers under /api, as on the cloud, so the rest of the address stays free for the
// web app itself (other devices in the shop opening it from this computer).
await app.ready();
server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")) {
    req.url = url.slice(4) || "/";
    app.routing(req, res);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" }).end(`{"error":"غير موجود"}`);
});
await new Promise<void>((resolve, reject) => {
  server!.once("error", reject);
  server!.listen(port, host, resolve);
});
console.log(`local server on http://${host}:${port}, data in ${dataDir}`);

/** Applies the SQL files in order, each once, each in one transaction. */
async function migrate(pg: PGlite, dir: string) {
  await pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pg.query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), "utf8");
    await pg.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    });
    console.log(`applied ${file}`);
  }
}

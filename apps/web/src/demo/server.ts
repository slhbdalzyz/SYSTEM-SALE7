// The whole API running inside the browser for the demo: the same route code as the server,
// on PGlite (PostgreSQL compiled to WebAssembly) instead of a real database.
import { PGlite } from "@electric-sql/pglite";
import m001 from "../../../api/migrations/001_init.sql?raw";
import m002 from "../../../api/migrations/002_customers_returns.sql?raw";
import m003 from "../../../api/migrations/003_device_kinds.sql?raw";
import m004 from "../../../api/migrations/004_saas.sql?raw";
import m005 from "../../../api/migrations/005_purchasing.sql?raw";
import m006 from "../../../api/migrations/006_branches.sql?raw";
import m007 from "../../../api/migrations/007_offers.sql?raw";
import m008 from "../../../api/migrations/008_online_payments.sql?raw";
import m009 from "../../../api/migrations/009_owner.sql?raw";
import { setGateway } from "../../../api/src/payments/gateway";
import { fakeGateway } from "../../../api/src/payments/fake";
import { authRoutes } from "../../../api/src/routes/auth";
import { adminRoutes } from "../../../api/src/routes/admin";
import { catalogRoutes } from "../../../api/src/routes/catalog";
import { salesRoutes } from "../../../api/src/routes/sales";
import { shiftRoutes } from "../../../api/src/routes/shifts";
import { stockRoutes } from "../../../api/src/routes/stock";
import { reportRoutes } from "../../../api/src/routes/reports";
import { customerRoutes } from "../../../api/src/routes/customers";
import { returnRoutes } from "../../../api/src/routes/returns";
import { deviceRoutes } from "../../../api/src/routes/devices";
import { platformRoutes } from "../../../api/src/routes/platform";
import { subscriptionRoutes } from "../../../api/src/routes/subscription";
import { purchasingRoutes } from "../../../api/src/routes/purchasing";
import { branchRoutes } from "../../../api/src/routes/branches";
import { offerRoutes } from "../../../api/src/routes/offers";
import { ownerRoutes } from "../../../api/src/routes/owner";
import { seedDemo } from "./seed";
import { checkSubscription } from "../../../api/src/billing";
// Type-only: brings in the server's Fastify type additions (app.db, req.user) for the route files.
import type {} from "../../../api/src/app";

type Req = {
  method: string;
  body: unknown;
  query: Record<string, string>;
  params: Record<string, string>;
  headers: Record<string, string>;
  user: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  jwtVerify: () => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  log: Console;
};
type Fn = (req: Req, reply: unknown) => unknown;
interface Route { method: string; parts: string[]; pre: Fn[]; handler: Fn }

/** One connection, used by one caller at a time, like a pool of size one. */
class Db {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private pg: PGlite) {}
  private async raw(sql: string, params: unknown[] = []) {
    const r = await this.pg.query(sql, params);
    return { rows: r.rows as any[], rowCount: Math.max(r.rows.length, r.affectedRows ?? 0) }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
  query(sql: string, params?: unknown[]) {
    return this.lock(() => this.raw(sql, params));
  }
  connect() {
    return new Promise<{ query: Db["raw"]; release: () => void }>((resolve) => {
      void this.lock(
        () =>
          new Promise<void>((done) => {
            resolve({ query: (s, p) => this.raw(s, p), release: () => done() });
          }),
      );
    });
  }
}

const b64 = (o: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/=+$/, "");

class MiniApp {
  routes: Route[] = [];
  constructor(public db: Db) {}
  // Demo tokens are not signed: everything runs in this one browser anyway.
  jwt = {
    sign: (p: object, o: { expiresIn: string }) => {
      const hours = Number(o.expiresIn.replace("h", "")) || 12;
      return `demo.${b64({ ...p, exp: Math.floor(Date.now() / 1000) + hours * 3600 })}.demo`;
    },
  };
  private add(method: string, path: string, a: unknown, b?: unknown) {
    const handler = (b ?? a) as Fn;
    const opts = (b ? a : {}) as { preHandler?: Fn | Fn[] };
    const pre = opts.preHandler ? ([] as Fn[]).concat(opts.preHandler) : [];
    this.routes.push({ method, parts: path.split("/").filter(Boolean), pre, handler });
  }
  get = (p: string, a: unknown, b?: unknown) => this.add("GET", p, a, b);
  post = (p: string, a: unknown, b?: unknown) => this.add("POST", p, a, b);
  put = (p: string, a: unknown, b?: unknown) => this.add("PUT", p, a, b);
  patch = (p: string, a: unknown, b?: unknown) => this.add("PATCH", p, a, b);
  async register(fn: (app: any) => Promise<void>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    await fn(this);
  }
  match(method: string, path: string) {
    const parts = path.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (r.parts.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = decodeURIComponent(parts[i])), true) : p === parts[i]))) {
        return { route: r, params };
      }
    }
    return null;
  }
}

let ready: Promise<MiniApp> | null = null;

async function boot(): Promise<MiniApp> {
  let pg: PGlite;
  const parsers = { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) };
  try {
    pg = await PGlite.create("idb://pos-demo", { parsers });
  } catch {
    pg = await PGlite.create({ parsers }); // storage blocked: keep data for this visit only
  }
  await pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)`);
  const done = new Set((await pg.query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  for (const [name, sql] of [["001_init.sql", m001], ["002_customers_returns.sql", m002], ["003_device_kinds.sql", m003], ["004_saas.sql", m004], ["005_purchasing.sql", m005], ["006_branches.sql", m006], ["007_offers.sql", m007], ["008_online_payments.sql", m008], ["009_owner.sql", m009]] as const) {
    if (done.has(name)) continue;
    await pg.exec(sql);
    await pg.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [name]);
  }
  const db = new Db(pg);
  const app = new MiniApp(db);
  setGateway(fakeGateway()); // Sadad and Edfali that accept the sandbox codes, no money involved
  for (const r of [authRoutes, adminRoutes, catalogRoutes, salesRoutes, shiftRoutes, stockRoutes, reportRoutes, customerRoutes, returnRoutes, deviceRoutes, platformRoutes, subscriptionRoutes, purchasingRoutes, branchRoutes, offerRoutes, ownerRoutes]) {
    await app.register(r);
  }
  await seedDemo(db);
  return app;
}

export function startDemo() {
  ready ??= boot();
  return ready;
}

export async function resetDemo() {
  const app = await startDemo();
  await app.db.query(`DROP SCHEMA public CASCADE`);
  await app.db.query(`CREATE SCHEMA public`);
}

/** Answers a request the way the HTTP server would: status and JSON body. */
export async function handle(method: string, url: string, token: string | null | undefined, body: unknown): Promise<{ status: number; data: unknown }> {
  const app = await startDemo();
  const u = new URL(url, "http://demo");
  const m = app.match(method, u.pathname);
  if (!m) return { status: 404, data: { error: "غير موجود" } };
  const req: Req = {
    method,
    body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)),
    query: Object.fromEntries(u.searchParams),
    params: m.params,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    user: undefined,
    log: console,
    jwtVerify: async () => {
      const t = token?.split(".")[1];
      if (!t) throw new Error("no token");
      const p = JSON.parse(decodeURIComponent(escape(atob(t))));
      if (p.exp * 1000 < Date.now()) throw new Error("expired");
      req.user = p;
      return p;
    },
  };
  try {
    // The server runs this as a hook before every route; so does the demo.
    await checkSubscription(app.db as never, method, u.pathname, token ? () => req.jwtVerify() : null);
    for (const p of m.route.pre) await p(req, {});
    return { status: 200, data: await m.route.handler(req, {}) };
  } catch (e) {
    const err = e as { name?: string; issues?: { path: (string | number)[]; message: string }[]; statusCode?: number; message: string };
    if (err.name === "ZodError" && err.issues) return { status: 400, data: { error: "بيانات غير صحيحة", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
    if (err.statusCode && err.statusCode < 500) return { status: err.statusCode, data: { error: err.message } };
    console.error(e);
    return { status: 500, data: { error: "خطأ في السيرفر" } };
  }
}

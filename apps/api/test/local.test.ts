// The desktop's local edition: the same API on PGlite, for one shop on one computer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../src/app";
import type { Db } from "../src/db";
import { PgliteDb, pgliteParsers } from "../src/pglite-db";
import { localRoutes } from "../src/local/routes";

let app: Awaited<ReturnType<typeof buildApp>>;
let pg: PGlite;
let stopped = 0;

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as "GET", url, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: body as object });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  process.env.POS_LOCAL = "1";
  pg = await PGlite.create({ parsers: pgliteParsers });
  const dir = path.join(__dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(path.join(dir, f), "utf8"));
  const db = new PgliteDb(pg);
  app = await buildApp({ db: db as unknown as Db, jwtSecret: "local-test-secret-local-test-secret-12" });
  await app.register(localRoutes, { shutdownToken: "tok", stop: () => stopped++ });
}, 60_000);
afterAll(async () => {
  delete process.env.POS_LOCAL;
  await app.close();
  await pg.close();
});

describe("local edition", () => {
  let owner = "";
  let storeId = "";

  it("starts with no shop, then sets one up on the first run", async () => {
    expect((await call("GET", "/local/status")).body).toEqual({ edition: "local", shop: null });
    const r = await call("POST", "/auth/register", undefined, { businessName: "بقالة الحي", storeName: "الرئيسي", ownerName: "سالم", email: "salem@shop.ly", password: "password123", planCode: "basic" });
    expect(r.status).toBe(200);
    owner = r.body.token;
    storeId = r.body.storeId;
    expect((await call("GET", "/local/status")).body.shop).toMatchObject({ id: expect.any(String), name: "بقالة الحي" });
  });

  it("opens everything for a 14-day trial, with no monthly plan", async () => {
    const t = (await pg.query<{ status: string; plan_code: string; days: number }>(`SELECT status, plan_code, round(extract(epoch from paid_until - now()) / 86400) AS days FROM tenants`)).rows[0];
    expect(t.status).toBe("trial");
    expect(t.plan_code).toBe("chain");
    expect(Number(t.days)).toBe(14);
  });

  it("holds one shop only", async () => {
    const r = await call("POST", "/auth/register", undefined, { businessName: "محل ثاني", storeName: "الرئيسي", ownerName: "علي", email: "ali@shop.ly", password: "password123" });
    expect(r.status).toBe(409);
  });

  it("takes many requests at once without mixing up transactions", async () => {
    const all = await Promise.all(
      Array.from({ length: 15 }, (_, i) => call("POST", "/products", owner, { name: `صنف ${i}`, costMinor: 500, units: [{ name: "حبة", priceMinor: 1000 + i, isBase: true }] })),
    );
    expect(all.map((r) => r.status)).toEqual(Array(15).fill(200));
    const n = (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM products`)).rows[0].n;
    expect(n).toBe(15);
  });

  it("registers this computer as a till", async () => {
    const r = await call("POST", "/devices", owner, { storeId, name: "كاشير 1", kind: "pos" });
    expect(r.status).toBe(200);
    expect(r.body.deviceToken).toHaveLength(64);
  });

  it("stops only when the app asks with its token", async () => {
    expect((await call("POST", "/local/shutdown", undefined, {}, { "x-shutdown-token": "nope" })).status).toBe(403);
    expect((await call("POST", "/local/shutdown", undefined, {}, { "x-shutdown-token": "tok" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(1);
  });
});

describe("finding the main computer on the shop's network", () => {
  it("answers a till that asks, and only that question", async () => {
    const { createSocket } = await import("node:dgram");
    const { startFinder, FIND_ASK } = await import("../src/local/network");
    const port = 47000 + Math.floor(Math.random() * 1000);
    const stop = startFinder(async () => ({ shopId: "t1", name: "بقالة الحي", port: 7400 }), port);
    await new Promise((r) => setTimeout(r, 100));
    const till = createSocket("udp4");
    const got: string[] = [];
    till.on("message", (m) => got.push(m.toString("utf8")));
    await new Promise<void>((r) => till.bind(0, "127.0.0.1", () => r()));
    till.send("hello", port, "127.0.0.1");
    till.send(FIND_ASK, port, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 300));
    stop();
    till.close();
    expect(got.map((g) => JSON.parse(g))).toEqual([{ app: "sale7-pos", shopId: "t1", name: "بقالة الحي", port: 7400 }]);
  });
});

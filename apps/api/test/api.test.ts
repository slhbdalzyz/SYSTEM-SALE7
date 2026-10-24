import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { computeTotals } from "@pos/shared";
import { buildApp } from "../src/app";
import { createPool } from "../src/db";
import { migrate } from "../src/migrate";

const db = createPool(process.env.TEST_DATABASE_URL ?? "postgres://pos:pos@localhost:5432/pos_test");
let app: Awaited<ReturnType<typeof buildApp>>;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const res = await app.inject({ method: method as "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body as object });
  return { status: res.statusCode, body: res.json() };
}

let owner: string;
let storeId: string;
let cashierToken: string;
let shiftId: string;
let pepsi: { productId: string; piece: string; carton: string };
let tomato: { productId: string; kg: string };

beforeAll(async () => {
  await db.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate(db);
  app = await buildApp({ db, jwtSecret: "test-secret-test-secret-test-secret-123" });
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("grocery POS flow", () => {
  it("registers a business and its owner", async () => {
    const r = await call("POST", "/auth/register", undefined, { businessName: "سوق النور", storeName: "الرئيسي", ownerName: "سالم", email: "salem@test.ly", password: "password123" });
    expect(r.status).toBe(200);
    owner = r.body.token;
    storeId = r.body.storeId;
    expect((await call("POST", "/auth/login", undefined, { email: "salem@test.ly", password: "wrong-pass" })).status).toBe(401);
  });

  it("creates products with units, barcodes and a weighed item", async () => {
    const r = await call("POST", "/products", owner, {
      name: "بيبسي",
      costMinor: 900,
      units: [
        { name: "علبة", factorMilli: 1000, priceMinor: 1500, isBase: true, barcodes: ["1111111111116"] },
        { name: "كرتونة", factorMilli: 24000, priceMinor: 32000, barcodes: ["2222222222222"] },
      ],
    });
    expect(r.status).toBe(200);
    pepsi = { productId: r.body.id, piece: r.body.units[0].id, carton: r.body.units[1].id };
    const t = await call("POST", "/products", owner, { name: "طماطم", isWeighted: true, scaleCode: "00101", costMinor: 2000, units: [{ name: "كيلو", priceMinor: 3500, isBase: true }] });
    expect(t.status).toBe(200);
    tomato = { productId: t.body.id, kg: t.body.units[0].id };
    const dup = await call("POST", "/products", owner, { name: "x", units: [{ name: "قطعة", priceMinor: 1, isBase: true, barcodes: ["1111111111116"] }] });
    expect(dup.status).toBe(409);
    await call("POST", "/purchases", owner, { storeId, lines: [{ unitId: pepsi.carton, qtyMilli: 2000, unitCostMinor: 21600 }] });
  });

  it("registers a device and signs a cashier in with a PIN", async () => {
    const d = await call("POST", "/devices", owner, { storeId, name: "كاشير 1" });
    expect(d.status).toBe(200);
    const u = await call("POST", "/users", owner, { name: "أحمد", role: "cashier", pin: "1234" });
    expect(u.status).toBe(200);
    const list = await call("POST", "/auth/device-users", undefined, { deviceToken: d.body.deviceToken });
    expect(list.body.users.map((x: { name: string }) => x.name)).toContain("أحمد");
    expect((await call("POST", "/auth/pin", undefined, { deviceToken: d.body.deviceToken, userId: u.body.id, pin: "0000" })).status).toBe(401);
    const login = await call("POST", "/auth/pin", undefined, { deviceToken: d.body.deviceToken, userId: u.body.id, pin: "1234" });
    expect(login.status).toBe(200);
    cashierToken = login.body.token;
  });

  it("does not let a cashier edit products", async () => {
    const r = await call("POST", "/products", cashierToken, { name: "x", units: [{ name: "قطعة", priceMinor: 1, isBase: true }] });
    expect(r.status).toBe(403);
  });

  it("gives the device the catalog for offline use", async () => {
    const r = await call("GET", "/sync/catalog", cashierToken);
    expect(r.body.products).toHaveLength(2);
    const later = await call("GET", `/sync/catalog?since=${encodeURIComponent(r.body.serverTime)}`, cashierToken);
    expect(later.body.products).toHaveLength(0);
  });

  it("records a sale once even when sent twice", async () => {
    shiftId = randomUUID();
    expect((await call("POST", "/shifts/open", cashierToken, { id: shiftId, openingCashMinor: 50000 })).status).toBe(200);
    const lines = [
      { productId: pepsi.productId, unitId: pepsi.piece, name: "بيبسي", qtyMilli: 3000, priceMinor: 1500 },
      { productId: tomato.productId, unitId: tomato.kg, name: "طماطم", qtyMilli: 1250, priceMinor: 3500 },
    ];
    const total = computeTotals(lines).total; // 4500 + 4375 = 8875
    const sale = { id: randomUUID(), number: "P1-000001", shiftId, createdAt: new Date().toISOString(), lines, payments: [{ method: "cash", amountMinor: 10000 }], totalMinor: total };
    const first = await call("POST", "/sales/batch", cashierToken, { sales: [sale] });
    expect(first.body.results[0].status).toBe("accepted");
    const again = await call("POST", "/sales/batch", cashierToken, { sales: [sale] });
    expect(again.body.results[0].status).toBe("duplicate");
    const n = await db.query(`SELECT count(*)::int AS n FROM sales`);
    expect(n.rows[0].n).toBe(1);
  });

  it("rejects a sale whose total does not add up", async () => {
    const sale = {
      id: randomUUID(), number: "P1-000002", shiftId, createdAt: new Date().toISOString(),
      lines: [{ productId: pepsi.productId, unitId: pepsi.piece, name: "بيبسي", qtyMilli: 1000, priceMinor: 1500 }],
      payments: [{ method: "cash", amountMinor: 1000 }], totalMinor: 1000,
    };
    const r = await call("POST", "/sales/batch", cashierToken, { sales: [sale] });
    expect(r.body.results[0].status).toBe("rejected");
  });

  it("moves stock in the base unit", async () => {
    const r = await call("GET", `/products?storeId=${storeId}`, owner);
    const p = r.body.find((x: { id: string }) => x.id === pepsi.productId);
    expect(p.stockMilli).toBe(48000 - 3000); // 2 cartons in, 3 cans out
    expect(p.costMinor).toBe(900); // 21.600 per carton ÷ 24
  });

  it("closes the shift with the expected cash", async () => {
    const r = await call("POST", `/shifts/${shiftId}/close`, cashierToken, { closingCashMinor: 58800 });
    expect(r.body.expectedCashMinor).toBe(50000 + 8875);
    expect(r.body.differenceMinor).toBe(-75);
  });

  it("reports the day", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date());
    const r = await call("GET", `/reports/daily?storeId=${storeId}&date=${today}`, owner);
    expect(r.body.sales_count).toBe(1);
    expect(r.body.total_minor).toBe(8875);
    expect(r.body.byMethod.cash).toBe(8875);
    expect(r.body.gross_profit_minor).toBe(8875 - 2700 - 2500);
  });

  it("keeps businesses apart", async () => {
    const other = await call("POST", "/auth/register", undefined, { businessName: "محل آخر", storeName: "فرع", ownerName: "علي", email: "ali@test.ly", password: "password123" });
    const r = await call("GET", "/products", other.body.token);
    expect(r.body).toHaveLength(0);
    const edit = await call("PUT", `/products/${pepsi.productId}`, other.body.token, { name: "hack", units: [{ name: "x", priceMinor: 1, isBase: true }] });
    expect(edit.status).toBe(404);
  });

  it("keeps the audit log append-only", async () => {
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    const r = await call("GET", "/audit", owner);
    expect(r.body.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(["shift.close", "user.pin_failed", "device.register"]));
  });
});

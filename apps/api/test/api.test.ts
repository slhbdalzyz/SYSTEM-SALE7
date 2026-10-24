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
let deviceToken: string;
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
    deviceToken = d.body.deviceToken;
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

describe("customers, credit and returns", () => {
  let shift2: string;
  let managerId: string;
  let customerId: string;
  let creditSale: { id: string; number: string };
  const pepsiLine = () => ({ productId: pepsi.productId, unitId: pepsi.piece, name: "بيبسي", qtyMilli: 4000, priceMinor: 1500 });
  const sale = (number: string, payments: { method: string; amountMinor: number }[], extra: object = {}) => ({
    id: randomUUID(), number, shiftId: shift2, createdAt: new Date().toISOString(), lines: [pepsiLine()],
    invoiceDiscountMinor: 400, payments, totalMinor: 5600, ...extra,
  });

  beforeAll(async () => {
    shift2 = randomUUID();
    await call("POST", "/shifts/open", cashierToken, { id: shift2, openingCashMinor: 0 });
    managerId = (await call("POST", "/users", owner, { name: "مدير", role: "manager", pin: "5555" })).body.id;
  });

  it("lets a cashier add a customer but not give them credit", async () => {
    const r = await call("POST", "/customers", cashierToken, { name: "محمد", phone: "0912345678", creditLimitMinor: 999999 });
    expect(r.status).toBe(200);
    expect(r.body.creditLimitMinor).toBe(0);
    customerId = r.body.id;
    expect((await call("PATCH", `/customers/${customerId}`, cashierToken, { creditLimitMinor: 8000 })).status).toBe(403);
    const u = await call("PATCH", `/customers/${customerId}`, owner, { creditLimitMinor: 8000 });
    expect(u.body.creditLimitMinor).toBe(8000);
    expect((await call("POST", "/customers", owner, { name: "ثاني", phone: "0912345678" })).status).toBe(409);
  });

  it("needs a customer to sell on credit", async () => {
    const r = await call("POST", "/sales/batch", cashierToken, { sales: [sale("P1-C1", [{ method: "credit", amountMinor: 5600 }])] });
    expect(r.body.results[0].status).toBe("rejected");
  });

  it("records a credit sale on the customer's balance", async () => {
    const s = sale("P1-C2", [{ method: "cash", amountMinor: 1600 }, { method: "credit", amountMinor: 4000 }], { customerId });
    creditSale = { id: s.id, number: s.number };
    expect((await call("POST", "/sales/batch", cashierToken, { sales: [s] })).body.results[0].status).toBe("accepted");
    const c = (await call("GET", "/customers?q=محمد", cashierToken)).body[0];
    expect(c.balanceMinor).toBe(4000);
  });

  it("keeps an offline credit sale past the limit and flags it", async () => {
    const s = sale("P1-C3", [{ method: "credit", amountMinor: 5600 }], { customerId, lines: [pepsiLine()] });
    expect((await call("POST", "/sales/batch", cashierToken, { sales: [s] })).body.results[0].status).toBe("accepted");
    const audit = await call("GET", "/audit", owner);
    expect(audit.body.map((a: { action: string }) => a.action)).toContain("customer.over_limit");
  });

  it("takes a payment once, even when retried", async () => {
    const pay = { id: randomUUID(), method: "cash", amountMinor: 3000, shiftId: shift2 };
    await call("POST", `/customers/${customerId}/payments`, cashierToken, pay);
    const r = await call("POST", `/customers/${customerId}/payments`, cashierToken, pay);
    expect(r.body.balanceMinor).toBe(4000 + 5600 - 3000);
    const st = await call("GET", `/customers/${customerId}/statement`, owner);
    expect(st.body.entries.map((e: { amount_minor: number }) => e.amount_minor)).toEqual([4000, 5600, -3000]);
    expect(st.body.entries.at(-1).balance_minor).toBe(6600);
  });

  it("finds a sale by number with what can still be returned", async () => {
    const r = await call("GET", `/sales/lookup?number=${creditSale.number}`, cashierToken);
    expect(r.body.lines[0].qty_milli).toBe(4000);
    expect(r.body.lines[0].returned_milli).toBe(0);
    expect(r.body.invoice_discount_minor).toBe(400);
  });

  it("asks for a manager PIN when a cashier makes a return", async () => {
    const orig = (await call("GET", `/sales/lookup?number=${creditSale.number}`, cashierToken)).body;
    const ret = { id: randomUUID(), number: "P1-R1", originalSaleId: orig.id, shiftId: shift2, lines: [{ saleLineId: orig.lines[0].id, qtyMilli: 1000 }], refundMethod: "credit", reason: "منتهي" };
    expect((await call("POST", "/returns", cashierToken, ret)).status).toBe(403);
    expect((await call("POST", "/returns", cashierToken, { ...ret, approval: { userId: managerId, pin: "0000" } })).status).toBe(403);
    const ok = await call("POST", "/returns", cashierToken, { ...ret, approval: { userId: managerId, pin: "5555" } });
    expect(ok.status).toBe(200);
    expect(ok.body.totalMinor).toBe(1400); // 6.000 − 0.400 discount = 5.600 for 4 cans → 1.400 each
    const again = await call("POST", "/returns", cashierToken, { ...ret, approval: { userId: managerId, pin: "5555" } });
    expect(again.body.status).toBe("duplicate");
    const c = (await call("GET", "/customers", owner)).body.find((x: { id: string }) => x.id === customerId);
    expect(c.balanceMinor).toBe(6600 - 1400);
  });

  it("never returns more than was sold", async () => {
    const orig = (await call("GET", `/sales/lookup?number=${creditSale.number}`, cashierToken)).body;
    expect(orig.lines[0].returned_milli).toBe(1000);
    const r = await call("POST", "/returns", cashierToken, {
      id: randomUUID(), number: "P1-R2", originalSaleId: orig.id, shiftId: shift2, lines: [{ saleLineId: orig.lines[0].id, qtyMilli: 3001 }],
      refundMethod: "cash", reason: "تجربة", approval: { userId: managerId, pin: "5555" },
    });
    expect(r.status).toBe(400);
  });

  it("puts returned goods back in stock and nets the day and the drawer", async () => {
    const before = (await call("GET", `/products?storeId=${storeId}`, owner)).body.find((x: { id: string }) => x.id === pepsi.productId).stockMilli;
    const orig = (await call("GET", `/sales/lookup?number=${creditSale.number}`, cashierToken)).body;
    const r = await call("POST", "/returns", cashierToken, {
      id: randomUUID(), number: "P1-R3", originalSaleId: orig.id, shiftId: shift2, lines: [{ saleLineId: orig.lines[0].id, qtyMilli: 1000 }],
      refundMethod: "cash", reason: "مكسور", approval: { userId: managerId, pin: "5555" },
    });
    expect(r.status).toBe(200);
    const after = (await call("GET", `/products?storeId=${storeId}`, owner)).body.find((x: { id: string }) => x.id === pepsi.productId).stockMilli;
    expect(after - before).toBe(1000);
    const cur = (await call("GET", "/shifts/current", cashierToken)).body.shift;
    expect(cur.expected).toBe(1600 + 3000 - 1400); // cash part of the sale + payment − cash refund
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date());
    const rep = (await call("GET", `/reports/daily?storeId=${storeId}&date=${today}`, owner)).body;
    expect(rep.returns_count).toBe(2);
    expect(rep.returns_minor).toBe(2800);
    expect(rep.customerPayments.cash).toBe(3000);
  });
});

describe("price checker and till events", () => {
  let checkerToken: string;

  it("registers a price checker that cannot be signed in on", async () => {
    const d = await call("POST", "/devices", owner, { storeId, name: "قارئ 1", kind: "price_checker" });
    expect(d.body.kind).toBe("price_checker");
    checkerToken = d.body.deviceToken;
    expect((await call("POST", "/auth/device-users", undefined, { deviceToken: checkerToken })).status).toBe(401);
  });

  it("gives the price checker prices but not costs", async () => {
    const r = await call("POST", "/price-checker/catalog", undefined, { deviceToken: checkerToken });
    expect(r.status).toBe(200);
    const p = r.body.products.find((x: { id: string }) => x.id === pepsi.productId);
    expect(p.units.map((u: { priceMinor: number }) => u.priceMinor)).toEqual([1500, 32000]);
    expect(p.costMinor).toBe(0);
  });

  it("does not serve the catalog to a till's token", async () => {
    expect((await call("POST", "/price-checker/catalog", undefined, { deviceToken })).status).toBe(401);
  });

  it("records a drawer opened with no sale", async () => {
    expect((await call("POST", "/devices/events", cashierToken, { action: "drawer.open", reason: "فكة" })).status).toBe(200);
    expect((await call("POST", "/devices/events", owner, { action: "drawer.open" })).status).toBe(403);
    const a = await call("GET", "/audit", owner);
    expect(a.body.map((x: { action: string }) => x.action)).toContain("drawer.open");
  });
});

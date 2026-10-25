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

describe("subscriptions and the platform back office", () => {
  let staff: string;
  let tenantId: string;

  it("starts new shops on a trial and signs platform staff in separately", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    await db.query(`INSERT INTO platform_admins (name, email, password_hash) VALUES ('صالح', 'admin@sale7.ly', $1)`, [await bcrypt.hash("platform-pass", 4)]);
    expect((await call("POST", "/platform/login", undefined, { email: "admin@sale7.ly", password: "nope" })).status).toBe(401);
    const l = await call("POST", "/platform/login", undefined, { email: "admin@sale7.ly", password: "platform-pass" });
    expect(l.status).toBe(200);
    staff = l.body.token;
    // A platform token is not a shop's token, and a shop's token is not a platform token.
    expect((await call("GET", "/products", staff)).status).toBe(403);
    expect((await call("GET", "/platform/tenants", owner)).status).toBe(403);

    const s = await call("GET", "/subscription", owner);
    expect(s.body.state).toBe("trial");
    expect(s.body.daysLeft).toBe(14);
    expect(s.body.plan.code).toBe("basic");
    expect(s.body.usage.devices).toBe(2);
    tenantId = (await db.query(`SELECT tenant_id FROM users WHERE email = 'salem@test.ly'`)).rows[0].tenant_id;
  });

  it("holds a shop to its plan's limits", async () => {
    const d = await call("POST", "/devices", owner, { storeId, name: "كاشير 3" });
    expect(d.status).toBe(402);
    expect(d.body.error).toContain("الأساسية");
  });

  it("lists shops with their state and usage", async () => {
    const list = await call("GET", "/platform/tenants?q=النور", staff);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: "سوق النور", state: "trial", devices: 2, owner_email: "salem@test.ly" });
    expect(list.body[0].sales30).toBeGreaterThan(0);
    const o = await call("GET", "/platform/overview", staff);
    expect(o.body.tenants).toBe(2);
    expect(o.body.byState.trial).toBe(2);
  });

  it("locks a shop whose trial ran out, but still takes the till's sales", async () => {
    await db.query(`UPDATE tenants SET paid_until = now() - interval '1 day' WHERE id = $1`, [tenantId]);
    // Skip the 20 s cache by recording through the API, which forgets the shop's cached state.
    await call("PATCH", `/platform/tenants/${tenantId}`, staff, { phone: "0910000000" });
    const s = await call("GET", "/subscription", owner);
    expect(s.body.state).toBe("locked");
    expect((await call("POST", "/products", owner, { name: "x", units: [{ name: "قطعة", priceMinor: 1, isBase: true }] })).status).toBe(402);
    const users = (await call("POST", "/auth/device-users", undefined, { deviceToken })).body.users as { id: string; name: string }[];
    const pin = await call("POST", "/auth/pin", undefined, { deviceToken, userId: users.find((u) => u.name === "أحمد")!.id, pin: "1234" });
    expect(pin.status).toBe(402);
    // A sale made before the lock, synced after it, is kept.
    const sale = { id: randomUUID(), shiftId, number: "LATE-1", createdAt: new Date().toISOString(), lines: [{ productId: pepsi.productId, unitId: pepsi.piece, name: "بيبسي", qtyMilli: 1000, priceMinor: 1500, discountMinor: 0, taxBp: 0 }], invoiceDiscountMinor: 0, payments: [{ method: "cash", amountMinor: 1500 }], totalMinor: 1500 };
    const r = await call("POST", "/sales/batch", cashierToken, { sales: [sale] });
    expect(r.status).toBe(200);
    expect(r.body.results[0].status).not.toBe("rejected");
    // The owner can still sign in to see the bill.
    expect((await call("POST", "/auth/login", undefined, { email: "salem@test.ly", password: "password123" })).status).toBe(200);
  });

  it("records a payment, which reopens the shop and moves the paid-up date", async () => {
    const p = await call("POST", `/platform/tenants/${tenantId}/payments`, staff, { months: 3, method: "bank", reference: "TRX-77", planCode: "pro" });
    expect(p.status).toBe(200);
    expect(p.body.amountMinor).toBe(900000);
    const s = await call("GET", "/subscription", owner);
    expect(s.body.state).toBe("active");
    expect(s.body.plan.code).toBe("pro");
    expect(s.body.daysLeft).toBeGreaterThanOrEqual(89);
    expect(s.body.payments).toHaveLength(1);
    expect((await call("POST", "/devices", owner, { storeId, name: "كاشير 3" })).status).toBe(200);

    // Paying early adds to what is left rather than starting from today.
    const before = new Date(s.body.paidUntil).getTime();
    await call("POST", `/platform/tenants/${tenantId}/payments`, staff, { months: 1, method: "cash" });
    const after = new Date((await call("GET", "/subscription", owner)).body.paidUntil).getTime();
    expect(Math.round((after - before) / 86_400_000)).toBeGreaterThanOrEqual(28);
  });

  it("gives a paying shop a grace period before locking", async () => {
    await db.query(`UPDATE tenants SET paid_until = now() - interval '2 days' WHERE id = $1`, [tenantId]);
    await call("PATCH", `/platform/tenants/${tenantId}`, staff, { phone: "0910000001" });
    expect((await call("GET", "/subscription", owner)).body.state).toBe("grace");
    expect((await call("POST", "/customers", owner, { name: "زبون جديد" })).status).toBe(200);
    // Renewing during the grace period pays for those days too: the month runs from the old end date.
    await call("POST", `/platform/tenants/${tenantId}/payments`, staff, { months: 1, method: "cash" });
    const left = (await call("GET", "/subscription", owner)).body.daysLeft as number;
    expect(left).toBeGreaterThanOrEqual(26);
    expect(left).toBeLessThanOrEqual(29);
  });

  it("suspends and reactivates a shop, and keeps a log of it", async () => {
    await call("PATCH", `/platform/tenants/${tenantId}`, staff, { status: "suspended", reason: "شيك راجع" });
    const r = await call("POST", "/customers", owner, { name: "زبون 2" });
    expect(r.status).toBe(402);
    expect(r.body.error).toContain("شيك راجع");
    await call("PATCH", `/platform/tenants/${tenantId}`, staff, { status: "active", extendDays: 10 });
    expect((await call("POST", "/customers", owner, { name: "زبون 2" })).status).toBe(200);
    const d = await call("GET", `/platform/tenants/${tenantId}`, staff);
    expect(d.body.payments).toHaveLength(3);
    expect(d.body.log.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(["payment.record", "tenant.update"]));
    await expect(db.query(`DELETE FROM platform_audit`)).rejects.toThrow(/append-only/);
  });

  it("edits plans and shows active ones publicly", async () => {
    await call("PUT", "/platform/plans/basic", staff, { name: "الأساسية", priceMinor: 120000, maxStores: 1, maxDevices: 2, maxUsers: 5, sort: 1 });
    const plans = (await call("GET", "/plans")).body as { code: string; price_minor: number }[];
    expect(plans.find((p) => p.code === "basic")!.price_minor).toBe(120000);
    const reg = await call("POST", "/auth/register", undefined, { businessName: "ملحمة", storeName: "فرع", ownerName: "علي", email: "butcher@test.ly", password: "password123", planCode: "chain", phone: "092" });
    const s = await call("GET", "/subscription", reg.body.token);
    expect(s.body.plan.code).toBe("chain");
  });
});

describe("purchasing and suppliers", () => {
  let t: string;
  let store: string;
  let rice: { id: string; bag: string; sack: string };
  let supplier: string;

  it("sets up a shop with a product sold by the bag and bought by the sack", async () => {
    const r = await call("POST", "/auth/register", undefined, { businessName: "بقالة الرز", storeName: "الرئيسي", ownerName: "منصور", email: "rice@test.ly", password: "password123" });
    t = r.body.token;
    store = r.body.storeId;
    const p = await call("POST", "/products", t, {
      name: "رز 1 كغ", costMinor: 0, minStockMilli: 20000,
      units: [{ name: "كيس", factorMilli: 1000, priceMinor: 4500, isBase: true, barcodes: ["9990000000017"] }, { name: "شوال 10", factorMilli: 10000, priceMinor: 42000, barcodes: [] }],
    });
    rice = { id: p.body.id, bag: p.body.units[0].id, sack: p.body.units[1].id };
    supplier = (await call("POST", "/suppliers", t, { name: "شركة الحبوب", phone: "0911112222" })).body.id;
  });

  it("receives an invoice paid in part, and owes the rest", async () => {
    const r = await call("POST", "/purchases", t, {
      storeId: store, supplierId: supplier, supplierRef: "F-1001", paidMinor: 50000, paymentMethod: "cash",
      lines: [{ unitId: rice.sack, qtyMilli: 3000, unitCostMinor: 35000 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.totalMinor).toBe(105000);
    const products = (await call("GET", `/products?storeId=${store}`, t)).body as { id: string; stockMilli: number; costMinor: number }[];
    const p = products.find((x) => x.id === rice.id)!;
    expect(p.stockMilli).toBe(30000); // 3 sacks of 10 bags
    expect(p.costMinor).toBe(3500); // per bag
    const sup = (await call("GET", "/suppliers", t)).body[0];
    expect(sup.balance_minor).toBe(55000);
    const inv = (await call("GET", `/purchases/${r.body.id}`, t)).body;
    expect(inv.lines[0]).toMatchObject({ name: "رز 1 كغ", unit_name: "شوال 10", qty_milli: 3000 });
    expect((await call("GET", "/purchases", t)).body[0].paid_minor).toBe(50000);
    expect((await call("POST", "/purchases", t, { storeId: store, supplierId: supplier, paidMinor: 999999, lines: [{ unitId: rice.bag, qtyMilli: 1000, unitCostMinor: 1 }] })).status).toBe(400);
  });

  it("pays the supplier later and shows it on the statement", async () => {
    const pay = await call("POST", `/suppliers/${supplier}/payments`, t, { amountMinor: 55000, method: "bank" });
    expect(pay.body.balanceMinor).toBe(0);
    const st = (await call("GET", `/suppliers/${supplier}/statement`, t)).body;
    expect(st.entries.map((e: { type: string }) => e.type)).toEqual(["invoice", "payment", "payment"]);
    expect(st.entries.at(-1).balance_minor).toBe(0);
  });

  it("suggests what to reorder, from whom and at what cost", async () => {
    await call("POST", "/stock/adjust", t, { storeId: store, productId: rice.id, qtyMilli: -15000, reason: "جرد" });
    const r = (await call("GET", `/stock/reorder?storeId=${store}`, t)).body;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: "رز 1 كغ", stock_milli: 15000, suggest_milli: 25000, supplier_name: "شركة الحبوب", last_unit_name: "شوال 10", last_cost_minor: 35000 });
  });

  it("keeps suppliers to their own shop and away from cashiers", async () => {
    expect((await call("GET", `/suppliers/${supplier}/statement`, owner)).status).toBe(404);
    expect((await call("GET", "/suppliers", cashierToken)).status).toBe(403);
  });
});

describe("branches and stock transfers", () => {
  let t: string;
  let main: string;
  let second: string;
  let oil: string;

  it("opens a second branch only on a plan that allows it", async () => {
    const r = await call("POST", "/auth/register", undefined, { businessName: "أسواق الفرعين", storeName: "الرئيسي", ownerName: "علي", email: "branches@test.ly", password: "password123", planCode: "basic" });
    t = r.body.token;
    main = r.body.storeId;
    expect((await call("POST", "/stores", t, { name: "فرع الهضبة" })).status).toBe(402);
    await db.query(`UPDATE tenants SET plan_code = 'chain' WHERE name = 'أسواق الفرعين'`);
    const s = await call("POST", "/stores", t, { name: "فرع الهضبة", address: "طرابلس" });
    expect(s.status).toBe(200);
    second = s.body.id;
    expect((await call("GET", "/me", t)).body.stores).toHaveLength(2);
    const p = await call("POST", "/products", t, { name: "زيت", costMinor: 10000, units: [{ name: "قنينة", priceMinor: 14000, isBase: true }] });
    oil = p.body.id;
    await call("POST", "/stock/adjust", t, { storeId: main, productId: oil, qtyMilli: 20000, reason: "رصيد" });
  });

  const stockAt = async (store: string) => ((await call("GET", `/products?storeId=${store}`, t)).body as { id: string; stockMilli: number }[]).find((x) => x.id === oil)!.stockMilli;

  it("sends goods out of one branch and receives them in the other, with a shortage", async () => {
    expect((await call("POST", "/transfers", t, { fromStoreId: main, toStoreId: second, lines: [{ productId: oil, qtyMilli: 50000 }] })).status).toBe(400);
    const tr = await call("POST", "/transfers", t, { fromStoreId: main, toStoreId: second, lines: [{ productId: oil, qtyMilli: 8000 }] });
    expect(tr.status).toBe(200);
    expect(tr.body.number).toBe(1);
    expect(await stockAt(main)).toBe(12000);
    expect(await stockAt(second)).toBe(0);
    const d = (await call("GET", `/transfers/${tr.body.id}`, t)).body;
    const rec = await call("POST", `/transfers/${tr.body.id}/receive`, t, { lines: [{ id: d.lines[0].id, receivedMilli: 7000 }] });
    expect(rec.body.shortMilli).toBe(1000);
    expect(await stockAt(second)).toBe(7000);
    expect((await call("POST", `/transfers/${tr.body.id}/receive`, t, {})).status).toBe(409);
    expect((await call("GET", `/transfers?storeId=${second}`, t)).body[0]).toMatchObject({ status: "received", short_milli: 1000, from_name: "الرئيسي", to_name: "فرع الهضبة" });
  });

  it("puts goods back when a transfer is cancelled", async () => {
    const tr = await call("POST", "/transfers", t, { fromStoreId: main, toStoreId: second, lines: [{ productId: oil, qtyMilli: 2000 }] });
    expect(tr.body.number).toBe(2);
    expect(await stockAt(main)).toBe(10000);
    expect((await call("POST", `/transfers/${tr.body.id}/cancel`, t)).status).toBe(200);
    expect(await stockAt(main)).toBe(12000);
    expect((await call("POST", `/transfers/${tr.body.id}/receive`, t)).status).toBe(409);
  });

  it("compares branches and keeps one branch on", async () => {
    const by = (await call("GET", "/stock/by-store", t)).body;
    expect(by[0].stock).toEqual({ [main]: 12000, [second]: 7000 });
    const rep = (await call("GET", "/reports/branches?from=2020-01-01&to=2030-01-01", t)).body;
    expect(rep.map((r: { name: string }) => r.name)).toEqual(["الرئيسي", "فرع الهضبة"]);
    expect((await call("GET", "/stores", t)).body[1].stock_value_minor).toBe(70000);
    expect((await call("PATCH", `/stores/${second}`, t, { active: false })).status).toBe(200);
    expect((await call("PATCH", `/stores/${main}`, t, { active: false })).status).toBe(400);
    expect((await call("POST", "/transfers", t, { fromStoreId: main, toStoreId: second, lines: [{ productId: oil, qtyMilli: 1000 }] })).status).toBe(400);
  });

  it("keeps transfers within the shop", async () => {
    expect((await call("POST", "/transfers", owner, { fromStoreId: main, toStoreId: second, lines: [{ productId: oil, qtyMilli: 1000 }] })).status).toBe(404);
    expect((await call("GET", "/stores", cashierToken)).status).toBe(403);
  });
});

describe("offers", () => {
  let t: string;
  let store: string;
  let till: string;
  let yog: { id: string; piece: string };
  let oil: { id: string; piece: string };
  let offerId: string;

  it("sets up a shop with a till", async () => {
    const r = await call("POST", "/auth/register", undefined, { businessName: "سوق العروض", storeName: "الرئيسي", ownerName: "هدى", email: "offers@test.ly", password: "password123" });
    t = r.body.token;
    store = r.body.storeId;
    const y = await call("POST", "/products", t, { name: "ياغورت", costMinor: 600, units: [{ name: "علبة", priceMinor: 1000, isBase: true }] });
    yog = { id: y.body.id, piece: y.body.units[0].id };
    const o = await call("POST", "/products", t, { name: "زيت", costMinor: 14000, units: [{ name: "قنينة", priceMinor: 18500, isBase: true }] });
    oil = { id: o.body.id, piece: o.body.units[0].id };
    const d = await call("POST", "/devices", t, { storeId: store, name: "كاشير" });
    const u = await call("POST", "/users", t, { name: "سارة", role: "cashier", pin: "4321" });
    till = (await call("POST", "/auth/pin", undefined, { deviceToken: d.body.deviceToken, userId: u.body.id, pin: "4321" })).body.token;
  });

  it("lets managers make offers and checks they are complete", async () => {
    expect((await call("POST", "/offers", t, { name: "ناقص", kind: "buy_get", buyQty: 2 })).status).toBe(400);
    expect((await call("POST", "/offers", till, { name: "2+1", kind: "buy_get", buyQty: 2, getQty: 1 })).status).toBe(403);
    const r = await call("POST", "/offers", t, { name: "ياغورت 2+1", kind: "buy_get", buyQty: 2, getQty: 1, productIds: [yog.id] });
    expect(r.status).toBe(200);
    offerId = r.body.id;
    await call("POST", "/offers", t, { name: "زيت قديم", kind: "percent", percentBp: 5000, productIds: [oil.id], endsAt: "2020-01-01T00:00:00Z" });
    const synced = (await call("GET", "/sync/offers", till)).body;
    expect(synced.map((o: { name: string }) => o.name)).toEqual(["ياغورت 2+1"]);
  });

  const sale = (promo: number, offer: string | null) => ({
    id: randomUUID(), number: `T-${randomUUID().slice(0, 6)}`, createdAt: new Date().toISOString(),
    lines: [
      { productId: yog.id, unitId: yog.piece, name: "ياغورت", qtyMilli: 3000, priceMinor: 1000, promoMinor: promo, offerId: offer, offerName: "ياغورت 2+1" },
      { productId: oil.id, unitId: oil.piece, name: "زيت", qtyMilli: 1000, priceMinor: 18500 },
    ],
    payments: [{ method: "cash", amountMinor: 30000 }], totalMinor: 21500 - promo,
  });

  it("takes a sale with the offer applied and records what it gave", async () => {
    const r = await call("POST", "/sales/batch", till, { sales: [sale(1000, offerId)] });
    expect(r.body.results[0].status).toBe("accepted");
    const line = (await db.query(`SELECT promo_minor, offer_id, total_minor, discount_minor FROM sale_lines WHERE name = 'ياغورت'`)).rows[0];
    expect(line).toMatchObject({ promo_minor: 1000, offer_id: offerId, total_minor: 2000, discount_minor: 1000 });
    const list = (await call("GET", "/offers", t)).body.find((o: { id: string }) => o.id === offerId);
    expect(list).toMatchObject({ salesCount: 1, givenMinor: 1000 });
    const flagged = await db.query(`SELECT 1 FROM audit_log WHERE action IN ('sale.offer_mismatch', 'sale.discount') AND entity_id = $1`, [r.body.results[0].id]);
    expect(flagged.rowCount).toBe(0);
  });

  it("keeps a sale from a device with an old offer list, and flags it", async () => {
    const s = sale(0, null);
    expect((await call("POST", "/sales/batch", till, { sales: [s] })).body.results[0].status).toBe("accepted");
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'sale.offer_mismatch' AND entity_id = $1`, [s.id])).rowCount).toBe(1);
  });

  it("stops an offer when it is switched off", async () => {
    const o = (await call("GET", "/offers", t)).body.find((x: { id: string }) => x.id === offerId);
    expect((await call("PUT", `/offers/${offerId}`, t, { ...o, active: false })).status).toBe(200);
    expect((await call("GET", "/sync/offers", till)).body).toHaveLength(0);
    expect((await call("PUT", `/offers/${offerId}`, owner, { ...o, active: false })).status).toBe(404);
  });
});

describe("generated barcodes", () => {
  it("numbers in-store codes per shop and refuses other shops' units", async () => {
    const r = await call("POST", "/auth/register", undefined, { businessName: "مخبز", storeName: "الرئيسي", ownerName: "نوري", email: "bread@test.ly", password: "password123" });
    const t = r.body.token;
    const p = await call("POST", "/products", t, { name: "خبز", units: [{ name: "رغيف", priceMinor: 250, isBase: true }, { name: "كيس 10", factorMilli: 10000, priceMinor: 2250 }] });
    const a = await call("POST", "/barcodes/generate", t, { unitId: p.body.units[0].id });
    const b = await call("POST", "/barcodes/generate", t, { unitId: p.body.units[1].id });
    expect(a.body.code).toBe("2990000000019");
    expect(b.body.code).toBe("2990000000026");
    const list = (await call("GET", `/products?storeId=${r.body.storeId}`, t)).body[0];
    expect(list.units.map((u: { barcodes: string[] }) => u.barcodes)).toEqual([["2990000000019"], ["2990000000026"]]);
    expect((await call("POST", "/barcodes/generate", owner, { unitId: p.body.units[0].id })).status).toBe(404);
  });
});

describe("online subscription payments", () => {
  let t: string;
  let tid: string;

  it("lets a locked shop pay by Sadad with the code it gets by SMS", async () => {
    const { setGateway } = await import("../src/payments/gateway");
    const { fakeGateway } = await import("../src/payments/fake");
    setGateway(fakeGateway());
    const r = await call("POST", "/auth/register", undefined, { businessName: "بقالة الدفع", storeName: "الرئيسي", ownerName: "سالم", email: "pay@test.ly", password: "password123", planCode: "basic" });
    t = r.body.token;
    tid = (await db.query(`SELECT id FROM tenants WHERE name = 'بقالة الدفع'`)).rows[0].id;
    await db.query(`UPDATE tenants SET paid_until = now() - interval '30 days' WHERE id = $1`, [tid]);
    const { forgetTenant } = await import("../src/billing");
    forgetTenant(tid);
    expect((await call("POST", "/categories", t, { name: "x" })).status).toBe(402); // locked

    const opts = (await call("GET", "/subscription/pay/options", t)).body;
    expect(opts.methods).toEqual(["sadad", "edfali"]);
    expect((await call("POST", "/subscription/pay/start", t, { planCode: "basic", months: 2, method: "sadad", mobile: "0913632323" })).status).toBe(400); // no birth year
    const s = await call("POST", "/subscription/pay/start", t, { planCode: "basic", months: 2, method: "sadad", mobile: "0913632323", birthYear: "1990" });
    expect(s.status).toBe(200);
    const basic = Number((await db.query(`SELECT price_minor FROM plans WHERE code = 'basic'`)).rows[0].price_minor);
    expect(s.body).toMatchObject({ needsCode: true, amountMinor: basic * 2 });
    const bad = await call("POST", `/subscription/pay/${s.body.id}/confirm`, t, { code: "123456" });
    expect(bad).toMatchObject({ status: 402, body: { error: "الرمز غير صحيح" } });
    const ok = await call("POST", `/subscription/pay/${s.body.id}/confirm`, t, { code: "111111" });
    expect(ok.status).toBe(200);
    expect((await call("POST", `/subscription/pay/${s.body.id}/confirm`, t, { code: "111111" })).status).toBe(409);

    const sub = (await call("GET", "/subscription", t)).body;
    expect(sub.state).toBe("active");
    expect(sub.daysLeft).toBeGreaterThan(55);
    expect(sub.payments[0]).toMatchObject({ method: "online", months: 2, amount_minor: basic * 2 });
    expect((await call("POST", "/categories", t, { name: "x" })).status).toBe(200); // unlocked
  });

  it("takes a card payment only back from a correctly signed return", async () => {
    const { setGateway } = await import("../src/payments/gateway");
    const { plutuGateway, plutuSignature, signedString } = await import("../src/payments/plutu");
    let sent: URLSearchParams | null = null;
    setGateway(plutuGateway({
      apiKey: "k", accessToken: "tok", secretKey: "s3cret",
      fetch: (async (_url: string, init: RequestInit) => {
        sent = init.body as URLSearchParams;
        return new Response(JSON.stringify({ status: 200, result: { code: "CHECKOUT_REDIRECT", redirect_url: "https://pay.example/checkout/1" } }), { status: 200 });
      }) as typeof fetch,
    }));
    const s = await call("POST", "/subscription/pay/start", t, { planCode: "pro", months: 1, method: "localbankcards" });
    expect(s.body.redirectUrl).toBe("https://pay.example/checkout/1");
    const pro = (Number((await db.query(`SELECT price_minor FROM plans WHERE code = 'pro'`)).rows[0].price_minor) / 1000).toFixed(2);
    expect(sent!.get("amount")).toBe(pro);
    expect(sent!.get("return_url")).toBe("http://localhost:80/api/billing/plutu/return");
    const inv = sent!.get("invoice_no")!;
    const q = `gateway=localbankcards&approved=1&invoice_no=${inv}&amount=${pro}&transaction_id=TX77`;
    const hashed = plutuSignature(signedString(q, ["gateway", "approved", "canceled", "invoice_no", "amount", "transaction_id"]), "s3cret");

    const forged = await app.inject({ method: "GET", url: `/billing/plutu/return?${q.replace(`amount=${pro}`, "amount=3.00")}&hashed=${hashed}` });
    expect(forged.headers.location).toContain("payment=invalid");
    const real = await app.inject({ method: "GET", url: `/billing/plutu/return?${q}&hashed=${hashed}` });
    expect(real.statusCode).toBe(302);
    expect(real.headers.location).toContain("payment=ok");
    const again = await app.inject({ method: "GET", url: `/billing/plutu/return?${q}&hashed=${hashed}` });
    expect(again.headers.location).toContain("payment=ok");
    const pays = (await call("GET", "/subscription", t)).body.payments;
    expect(pays).toHaveLength(2);
    expect(pays[0]).toMatchObject({ method: "online", plan_code: "pro" });
    const { setGateway: reset } = await import("../src/payments/gateway");
    reset(null);
  });

  it("keeps other people out of a shop's payments", async () => {
    expect((await call("GET", "/subscription/pay/options", cashierToken)).status).toBe(403);
    const anyIntent = (await db.query(`SELECT id FROM payment_intents LIMIT 1`)).rows[0].id;
    expect((await call("GET", `/subscription/pay/${anyIntent}`, owner)).status).toBe(404);
  });
});

describe("the owner's phone: dashboard, alerts, expenses, backup", () => {
  let t: string;
  let store: string;
  let till: string;
  let tillShift: string;
  let deviceId: string;
  let rice: { id: string; piece: string };
  const pushed: { endpoint: string; payload: string }[] = [];

  const sale = (qty: number, discount = 0) => ({
    id: randomUUID(), number: `R-${randomUUID().slice(0, 6)}`, shiftId: tillShift, createdAt: new Date().toISOString(),
    lines: [{ productId: rice.id, unitId: rice.piece, name: "رز", qtyMilli: qty * 1000, priceMinor: 10000, discountMinor: discount }],
    payments: [{ method: "cash", amountMinor: qty * 10000 - discount }], totalMinor: qty * 10000 - discount,
  });

  it("sets up a shop with stock near its minimum", async () => {
    const { setPusher } = await import("../src/alerts");
    setPusher(async (to, payload) => {
      pushed.push({ endpoint: to.endpoint, payload });
      return to.endpoint.endsWith("/gone") ? { gone: true } : {};
    }, "BPUBLICKEY");
    const r = await call("POST", "/auth/register", undefined, { businessName: "سوق الهاتف", storeName: "الرئيسي", ownerName: "علي", email: "phone@test.ly", password: "password123" });
    t = r.body.token;
    store = r.body.storeId;
    const p = await call("POST", "/products", t, { name: "رز", costMinor: 7000, minStockMilli: 5000, units: [{ name: "كيس", priceMinor: 10000, isBase: true }] });
    rice = { id: p.body.id, piece: p.body.units[0].id };
    await call("POST", "/purchases", t, { storeId: store, lines: [{ unitId: rice.piece, qtyMilli: 8000, unitCostMinor: 7000 }] });
    const d = await call("POST", "/devices", t, { storeId: store, name: "كاشير الهاتف" });
    deviceId = d.body.id;
    const u = await call("POST", "/users", t, { name: "مراد", role: "cashier", pin: "5555" });
    till = (await call("POST", "/auth/pin", undefined, { deviceToken: d.body.deviceToken, userId: u.body.id, pin: "5555" })).body.token;
    tillShift = randomUUID();
    await call("POST", "/shifts/open", till, { id: tillShift, openingCashMinor: 20000 });
    expect((await call("POST", "/push/subscribe", t, { endpoint: "https://push.example/phone1", keys: { p256dh: "BKEY-0123456789", auth: "auth-01234" } })).status).toBe(200);
    await call("POST", "/push/subscribe", t, { endpoint: "https://push.example/gone", keys: { p256dh: "BKEY-0123456789", auth: "auth-01234" } });
  });

  it("alerts once when a product crosses its minimum, and again when it runs out", async () => {
    await call("POST", "/sales/batch", till, { sales: [sale(2)] }); // 8 → 6, still above 5
    expect((await call("GET", "/alerts", t)).body.alerts).toHaveLength(0);
    await call("POST", "/sales/batch", till, { sales: [sale(2)] }); // 6 → 4
    await call("POST", "/sales/batch", till, { sales: [sale(1)] }); // 4 → 3, already low: no new alert
    const a = (await call("GET", "/alerts", t)).body;
    expect(a.alerts.map((x: { kind: string }) => x.kind)).toEqual(["low_stock"]);
    expect(a.alerts[0].body).toContain("باقي 4");
    await call("POST", "/sales/batch", till, { sales: [sale(3)] }); // 3 → 0
    expect((await call("GET", "/alerts", t)).body.alerts[0]).toMatchObject({ kind: "out_of_stock", title: "خلص: رز" });
    expect(pushed.filter((p) => p.endpoint.endsWith("phone1")).map((p) => JSON.parse(p.payload).tag)).toEqual(["low_stock", "out_of_stock"]);
    // The phone that unsubscribed is forgotten after its first failed push.
    expect((await db.query(`SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint LIKE '%/gone'`)).rows[0].n).toBe(0);
  });

  it("alerts on a big discount and a short drawer, by the shop's own limits", async () => {
    await call("POST", "/purchases", t, { storeId: store, lines: [{ unitId: rice.piece, qtyMilli: 20000, unitCostMinor: 7000 }] });
    expect((await call("PUT", "/alerts/settings", till, { discountOverMinor: 1 })).status).toBe(403);
    expect((await call("PUT", "/alerts/settings", t, { discountOverMinor: 3000, cashDiffOverMinor: 2000 })).body).toMatchObject({ discountOverMinor: 3000, lowStock: true });
    await call("POST", "/sales/batch", till, { sales: [sale(1, 1000)] }); // under the limit
    await call("POST", "/sales/batch", till, { sales: [sale(2, 4000)] });
    const close = await call("POST", `/shifts/${tillShift}/close`, till, { closingCashMinor: 0 });
    expect(close.body.differenceMinor).toBeLessThan(-2000);
    const kinds = (await call("GET", "/alerts", t)).body.alerts.map((x: { kind: string }) => x.kind);
    expect(kinds.slice(0, 2)).toEqual(["cash_diff", "big_discount"]);
    expect(kinds.filter((k: string) => k === "big_discount")).toHaveLength(1);
  });

  it("marks alerts read", async () => {
    const before = (await call("GET", "/alerts", t)).body;
    expect(before.unread).toBe(4);
    await call("POST", "/alerts/read", t, { ids: [before.alerts[0].id] });
    expect((await call("GET", "/alerts", t)).body.unread).toBe(3);
    await call("POST", "/alerts/read", t, {});
    expect((await call("GET", "/alerts", t)).body.unread).toBe(0);
    expect((await call("GET", "/alerts", till)).status).toBe(403);
  });

  it("shows today against yesterday and the month after expenses", async () => {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date());
    expect((await call("POST", "/expenses", t, { storeId: store, category: "كهرباء", amountMinor: 15000, spentOn: day })).status).toBe(200);
    await call("POST", "/expenses", t, { storeId: store, category: "إيجار", amountMinor: 500000, spentOn: `${day.slice(0, 7)}-01` });
    expect((await call("POST", "/expenses", till, { storeId: store, category: "x", amountMinor: 1, spentOn: day })).status).toBe(403);
    const d = (await call("GET", "/dashboard", t)).body;
    // 11 bags sold at 10.000, less 5.000 in discounts; each bag cost 7.000.
    expect(d.today).toMatchObject({ totalMinor: 105000, salesCount: 6, profitMinor: 105000 - 77000, expensesMinor: 15000, netMinor: 105000 - 77000 - 15000 });
    expect(d.month.expensesMinor).toBe(515000);
    expect(d.month.netMinor).toBe(d.month.profitMinor - 515000);
    expect(d.week).toHaveLength(7);
    expect(d.week[6]).toMatchObject({ day, totalMinor: 105000 });
    expect(d.stores).toEqual([expect.objectContaining({ name: "الرئيسي", totalMinor: 105000 })]);
    expect(d.lowStock.count).toBe(0);
    expect(d.openShifts).toHaveLength(0);
    const e = (await call("GET", `/expenses?month=${day.slice(0, 7)}`, t)).body;
    expect(e.totalMinor).toBe(515000);
    await call("POST", `/expenses/${e.expenses.find((x: { category: string }) => x.category === "كهرباء").id}/delete`, t);
    expect((await call("GET", "/dashboard", t)).body.today.expensesMinor).toBe(0);
  });

  it("backs up the whole shop page by page, without secrets, for the owner or an allowed till", async () => {
    expect((await call("GET", "/backup", till)).status).toBe(403);
    const m = (await call("GET", "/backup", t)).body;
    expect(m.format).toBe("pos-backup-1");
    const sales = m.tables.find((x: { name: string }) => x.name === "sales");
    expect(sales.rows).toBe(6);
    const first = (await call("GET", "/backup/sales?limit=5", t)).body;
    expect(first.rows).toHaveLength(5);
    const rest = (await call("GET", `/backup/sales?limit=5&after=${first.next}`, t)).body;
    expect(rest.rows).toHaveLength(1);
    expect(rest.next).toBeNull();
    expect(new Set([...first.rows, ...rest.rows].map((r: { id: string }) => r.id)).size).toBe(6);
    const users = (await call("GET", "/backup/users", t)).body.rows;
    expect(users.length).toBe(2);
    expect(users.some((u: Record<string, unknown>) => "password_hash" in u || "pin_hash" in u)).toBe(false);
    expect((await call("GET", "/backup/devices", t)).body.rows.some((d: Record<string, unknown>) => "token_hash" in d)).toBe(false);
    expect((await call("GET", "/backup/platform_admins", t)).status).toBe(404);
    expect((await call("GET", "/backup/sales?after=1;drop", t)).status).toBe(400);
    // Another shop's backup holds none of this shop's rows.
    expect((await call("GET", "/backup/sales", owner)).body.rows.every((r: { tenant_id: string }) => r.tenant_id !== m.tenantId)).toBe(true);

    expect((await call("PATCH", `/devices/${deviceId}/backup`, till, { backup: true })).status).toBe(403);
    expect((await call("PATCH", `/devices/${deviceId}/backup`, t, { backup: true })).status).toBe(200);
    expect((await call("GET", "/backup/products", till)).body.rows).toHaveLength(1);
    const { setPusher } = await import("../src/alerts");
    setPusher(null, null);
  });

  it("makes its own push keys once and keeps the private one to itself", async () => {
    const { setupPush } = await import("../src/push");
    const { pushPublicKey, setPusher } = await import("../src/alerts");
    await setupPush(db);
    const first = pushPublicKey();
    expect(first).toMatch(/^B[A-Za-z0-9_-]{80,}$/);
    await setupPush(db);
    expect(pushPublicKey()).toBe(first);
    expect((await call("GET", "/alerts/settings", t)).body.pushKey).toBe(first);
    const admin = await db.query(`SELECT 1 FROM platform_settings WHERE key = 'vapid'`);
    expect(admin.rowCount).toBe(1);
    const staff = (await call("POST", "/platform/login", undefined, { email: "admin@sale7.ly", password: "platform-pass" })).body.token;
    const settings = (await call("GET", "/platform/settings", staff)).body;
    expect(settings.grace_days).toBeDefined();
    expect(settings.vapid).toBeUndefined();
    setPusher(null, null);
  });
});

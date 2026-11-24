// Desktop licences: the platform issues and renews signed keys; the shop's computer checks them offline.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../src/app";
import type { Db } from "../src/db";
import { PgliteDb, pgliteParsers } from "../src/pglite-db";
import { formatMachineId, newKeyPair, readLicense, signLicense, type LicensePayload } from "../src/license";
import { LocalLicense } from "../src/local/license";
import { assertWithinPlan, setLocalDeviceLimit } from "../src/billing";
import { DEFAULT_LICENSE_PLANS, quoteLicense, upgradePrice } from "@pos/shared";

const keys = newKeyPair();
const MACHINE = formatMachineId("test-machine");
const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({ v: 1, id: "11111111-1111-4111-8111-111111111111", root: "11111111-1111-4111-8111-111111111111", shop: "بقالة", machine: MACHINE, from: "2026-11-20", until: "2027-11-19", devices: 1, issued: new Date().toISOString(), ...over });

async function migrated() {
  const pg = await PGlite.create({ parsers: pgliteParsers });
  const dir = path.join(__dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(path.join(dir, f), "utf8"));
  return pg;
}

describe("licence keys", () => {
  it("reads a genuine key and refuses a changed or foreign one", () => {
    const key = signLicense(payload(), keys.privateKey);
    expect(readLicense(key, [keys.publicKey]).until).toBe("2027-11-19");
    // Spaces and line breaks from WhatsApp do not matter.
    expect(readLicense(key.replace(/(.{40})/g, "$1\n "), [keys.publicKey]).shop).toBe("بقالة");
    const [t, , sig] = key.split(".");
    const forged = `${t}.${Buffer.from(JSON.stringify(payload({ until: "2099-12-31" }))).toString("base64url")}.${sig}`;
    expect(() => readLicense(forged, [keys.publicKey])).toThrow("غير صحيح");
    expect(() => readLicense(key, [newKeyPair().publicKey])).toThrow("غير صحيح");
    expect(() => readLicense("hello", [keys.publicKey])).toThrow("مش مفتاح");
  });

  it("formats a computer's ID the same way every time", () => {
    expect(MACHINE).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect(formatMachineId(" TEST-MACHINE\n")).toBe(MACHINE);
  });
});

describe("packages", () => {
  it("prices a package with extra tills and a multi-year discount", () => {
    expect(quoteLicense(DEFAULT_LICENSE_PLANS, { planId: "small", extra: 0, years: 1 })).toMatchObject({ devices: 1, totalMinor: 700_000 });
    expect(quoteLicense(DEFAULT_LICENSE_PLANS, { planId: "medium", extra: 1, years: 1 })).toMatchObject({ devices: 4, annualMinor: 1_450_000 });
    // 3 years of the large package, 15% off.
    expect(quoteLicense(DEFAULT_LICENSE_PLANS, { planId: "large", extra: 0, years: 3 })).toMatchObject({ discountPct: 15, totalMinor: 3_825_000 });
  });

  it("charges an upgrade only for the days left", () => {
    // Half a year left, small → medium: half of the 500 difference.
    const u = upgradePrice({ oldAnnualMinor: 700_000, newAnnualMinor: 1_200_000, today: "2027-05-21", until: "2027-11-19" });
    expect(u.days).toBe(183); // the last day counts
    expect(u.totalMinor).toBe(251_000);
    expect(upgradePrice({ oldAnnualMinor: 1_200_000, newAnnualMinor: 700_000, today: "2027-05-21", until: "2027-11-19" }).totalMinor).toBe(0);
  });
});

describe("the shop's computer", () => {
  let pg: PGlite;
  let db: PgliteDb;
  let dir: string;
  beforeAll(async () => {
    pg = await migrated();
    db = new PgliteDb(pg);
    await pg.query(`INSERT INTO tenants (name, plan_code, status, paid_until) VALUES ('بقالة', 'chain', 'trial', now())`);
    dir = mkdtempSync(path.join(tmpdir(), "pos-lic-"));
  }, 60_000);
  afterAll(async () => {
    await pg.close();
    rmSync(dir, { recursive: true });
  });
  const tenant = async () => (await pg.query<{ status: string; until: string; reason: string | null }>(`SELECT status, to_char(paid_until, 'YYYY-MM-DD') AS until, status_reason AS reason FROM tenants`)).rows[0];

  it("gives 14 days from the first run without a key", async () => {
    const lic = new LocalLicense(dir, MACHINE, [keys.publicKey], null);
    await lic.apply(db);
    const t = await tenant();
    expect(t.status).toBe("trial");
    const created = (await pg.query<{ d: string }>(`SELECT to_char(created_at + interval '14 days', 'YYYY-MM-DD') AS d FROM tenants`)).rows[0].d;
    expect(t.until).toBe(created);
  });

  it("refuses a key for another computer, and takes its own", async () => {
    const lic = new LocalLicense(dir, MACHINE, [keys.publicKey], null);
    expect(() => lic.activate(signLicense(payload({ machine: "AAAA-BBBB-CCCC-DDDD" }), keys.privateKey))).toThrow("لجهاز ثاني");
    lic.activate(signLicense(payload(), keys.privateKey));
    await lic.apply(db);
    expect(await tenant()).toMatchObject({ status: "active", until: "2027-11-19" });
    // An older key does not replace a newer one.
    expect(() => lic.activate(signLicense(payload({ until: "2027-01-01" }), keys.privateKey))).toThrow("أحدث");
    // The key is kept: a restart reads it back.
    expect(new LocalLicense(dir, MACHINE, [keys.publicKey], null).current()?.until).toBe("2027-11-19");
  });

  it("locks when the clock is turned back, and opens again when it is right", async () => {
    const lic = new LocalLicense(dir, MACHINE, [keys.publicKey], null);
    await lic.apply(db, Date.now() + 10 * 86_400_000);
    await lic.apply(db, Date.now());
    expect((await tenant()).status).toBe("suspended");
    await lic.apply(db, Date.now() + 10 * 86_400_000);
    expect((await tenant()).status).toBe("active");
  });

  it("counts cashier tills only against the licence", async () => {
    const tid = (await pg.query<{ id: string }>(`SELECT id FROM tenants`)).rows[0].id;
    setLocalDeviceLimit(0);
    try {
      await expect(assertWithinPlan(db as unknown as Db, tid, "devices", "pos")).rejects.toThrow("كاشير");
      await expect(assertWithinPlan(db as unknown as Db, tid, "devices", "kitchen")).resolves.toBeUndefined();
      await expect(assertWithinPlan(db as unknown as Db, tid, "devices", "price_checker")).resolves.toBeUndefined();
    } finally {
      setLocalDeviceLimit(null);
    }
  });

  it("takes an upgrade with the same end date when it was issued later", () => {
    const d = mkdtempSync(path.join(tmpdir(), "pos-lic-"));
    const lic = new LocalLicense(d, MACHINE, [keys.publicKey], null);
    lic.activate(signLicense(payload({ issued: "2026-11-20T10:00:00.000Z" }), keys.privateKey));
    lic.activate(signLicense(payload({ devices: 3, plan: "متوسط", issued: "2027-03-01T10:00:00.000Z" }), keys.privateKey));
    expect(lic.current()).toMatchObject({ devices: 3, plan: "متوسط" });
    expect(() => lic.activate(signLicense(payload({ issued: "2026-11-21T10:00:00.000Z" }), keys.privateKey))).toThrow();
    rmSync(d, { recursive: true });
  });

  it("says so when the build has no key to check with", () => {
    const lic = new LocalLicense(mkdtempSync(path.join(tmpdir(), "pos-lic-")), MACHINE, [], null);
    expect(() => lic.activate(signLicense(payload(), keys.privateKey))).toThrow("حمّل آخر نسخة");
  });
});

describe("the platform", () => {
  let pg: PGlite;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let staff = "";
  beforeAll(async () => {
    pg = await migrated();
    app = await buildApp({ db: new PgliteDb(pg) as unknown as Db, jwtSecret: "license-test-secret-license-test-secret" });
    const bcrypt = (await import("bcryptjs")).default;
    await pg.query(`INSERT INTO platform_admins (name, email, password_hash) VALUES ('صالح', 'admin@sale7.ly', $1)`, [await bcrypt.hash("platform-pass", 4)]);
    staff = (await app.inject({ method: "POST", url: "/platform/login", payload: { email: "admin@sale7.ly", password: "platform-pass" } })).json().token;
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await pg.close();
  });
  const call = async (method: string, url: string, body?: unknown, token = staff) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: r.json() };
  };

  it("issues a year for a computer, and the next year as a renewal the app can fetch", async () => {
    const pub = (await call("GET", "/licenses/public-key", undefined, "")).body.publicKey;
    expect((await call("POST", "/platform/licenses", { shopName: "بقالة", machineId: "nope" })).status).toBe(400);
    expect((await call("POST", "/platform/licenses", { shopName: "بقالة", machineId: MACHINE }, "")).status).toBe(401);
    const a = await call("POST", "/platform/licenses", { shopName: "بقالة النور", machineId: MACHINE.toLowerCase().replace(/-/g, ""), years: 1, amountMinor: 500000 });
    expect(a.status).toBe(200);
    const first = readLicense(a.body.key, [pub]);
    expect(first.machine).toBe(MACHINE);
    expect(first.from).toBe(new Date().toISOString().slice(0, 10));

    const b = await call("POST", "/platform/licenses", { shopName: "بقالة النور", machineId: MACHINE, renewOf: a.body.id });
    const second = readLicense(b.body.key, [pub]);
    expect(second.root).toBe(first.id);
    // The renewal starts the day after the first year ends.
    const next = new Date(`${first.until}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    expect(second.from).toBe(next.toISOString().slice(0, 10));

    const latest = await call("GET", `/licenses/${first.id}/latest?machine=${MACHINE}`, undefined, "");
    expect(latest.body.key).toBe(b.body.key);
    expect((await call("GET", `/licenses/${first.id}/latest?machine=AAAA-BBBB-CCCC-DDDD`, undefined, "")).status).toBe(404);
    const list = await call("GET", "/platform/licenses");
    expect(list.body).toHaveLength(2);
  });

  it("keeps the packages, and issues and upgrades by package", async () => {
    expect((await call("GET", "/licenses/plans", undefined, "")).body.plans.map((p: { id: string }) => p.id)).toEqual(["small", "medium", "large"]);
    const mine = { ...DEFAULT_LICENSE_PLANS, plans: DEFAULT_LICENSE_PLANS.plans.map((p) => (p.id === "small" ? { ...p, priceMinor: 800_000 } : p)), sellerPhone: "0912345678" };
    expect((await call("PUT", "/platform/license-plans", { ...mine, plans: [mine.plans[0], mine.plans[0]] })).status).toBe(400);
    expect((await call("PUT", "/platform/license-plans", mine)).status).toBe(200);
    expect((await call("GET", "/licenses/plans", undefined, "")).body).toMatchObject({ sellerPhone: "0912345678", plans: [{ id: "small", priceMinor: 800_000 }, {}, {}] });

    const pub = (await call("GET", "/licenses/public-key", undefined, "")).body.publicKey;
    const M2 = formatMachineId("plan-machine");
    const a = await call("POST", "/platform/licenses", { shopName: "محل صغير", machineId: M2, plan: "small", extraDevices: 1, years: 2 });
    expect(a.status).toBe(200);
    const k = readLicense(a.body.key, [pub]);
    expect(k).toMatchObject({ devices: 2, plan: "صغير" });
    const row = (await call("GET", "/platform/licenses")).body.find((r: { id: string }) => r.id === a.body.id);
    // (800 + 250) × 2 years − 10%
    expect(row).toMatchObject({ plan: "small", extra_devices: 1, annual_minor: 1_050_000, amount_minor: 1_890_000 });

    expect((await call("POST", `/platform/licenses/${a.body.id}/upgrade`, { plan: "small", extraDevices: 0 })).status).toBe(400);
    const u = await call("POST", `/platform/licenses/${a.body.id}/upgrade`, { plan: "large", extraDevices: 0 });
    expect(u.status).toBe(200);
    const up = readLicense(u.body.key, [pub]);
    expect(up).toMatchObject({ devices: 5, until: k.until, root: k.root, plan: "كبير" });
    const urow = (await call("GET", "/platform/licenses")).body.find((r: { id: string }) => r.id === u.body.id);
    expect(urow.upgrade_of).toBe(a.body.id);
    // A whole year (and more) left on a 2-year key: charged for at most a year of the difference.
    expect(urow.amount_minor).toBe(1_500_000 - 1_050_000);
    // The app fetching its latest key gets the upgrade.
    expect((await call("GET", `/licenses/${k.root}/latest?machine=${M2}`, undefined, "")).body.key).toBe(u.body.key);
  });
});

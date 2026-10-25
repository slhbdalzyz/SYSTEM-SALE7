// The demo shop: same data as `pnpm seed` on the server, made the first time the demo opens.
import bcrypt from "bcryptjs";
import { hashToken } from "../../../api/src/auth";

export const DEMO_DEVICE_TOKEN = "d".repeat(64);
export const DEMO_CHECKER_TOKEN = "c".repeat(64);

interface Q {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function seedDemo(db: Q) {
  if ((await db.query(`SELECT 1 FROM users LIMIT 1`)).rows.length) {
    await addPriceChecker(db);
    return addPlatform(db);
  }
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]?.id as string;
  const hash = (s: string) => bcrypt.hash(s, 8);

  const tid = await one(`INSERT INTO tenants (name) VALUES ('سوبرماركت التجربة') RETURNING id`);
  const sid = await one(`INSERT INTO stores (tenant_id, name, address, receipt_footer) VALUES ($1,'الفرع الرئيسي','طرابلس','شكراً لزيارتكم') RETURNING id`, [tid]);
  await db.query(`INSERT INTO users (tenant_id, name, email, password_hash, pin_hash, role) VALUES ($1,'المالك','owner@demo.ly',$2,$3,'owner')`, [tid, await hash("demo12345"), await hash("9999")]);
  await db.query(`INSERT INTO users (tenant_id, name, pin_hash, role) VALUES ($1,'أحمد الكاشير',$2,'cashier')`, [tid, await hash("1234")]);
  await db.query(`INSERT INTO devices (tenant_id, store_id, name, prefix, token_hash) VALUES ($1,$2,'كاشير 1','P1',$3)`, [tid, sid, hashToken(DEMO_DEVICE_TOKEN)]);
  await addPriceChecker(db);
  await addPlatform(db);
  await db.query(`INSERT INTO customers (tenant_id, name, phone, credit_limit_minor) VALUES ($1,'محمد الطرابلسي','0912345678',200000), ($1,'مطعم الواحة','0923456789',NULL)`, [tid]);

  const cat = (n: string) => one(`INSERT INTO categories (tenant_id, name) VALUES ($1,$2) RETURNING id`, [tid, n]);
  const drinks = await cat("مشروبات");
  const dairy = await cat("ألبان");
  const veg = await cat("خضرة وفواكه");
  const meat = await cat("لحوم");
  const pantry = await cat("مواد غذائية");

  type U = { name: string; factor: number; price: number; barcodes: string[] };
  const product = async (name: string, categoryId: string, cost: number, units: U[], scaleCode: string | null = null) => {
    const pid = await one(
      `INSERT INTO products (tenant_id, name, category_id, is_weighted, scale_code, cost_minor, min_stock_milli) VALUES ($1,$2,$3,$4,$5,$6,10000) RETURNING id`,
      [tid, name, categoryId, scaleCode !== null, scaleCode, cost],
    );
    for (const [i, u] of units.entries()) {
      const uid = await one(
        `INSERT INTO product_units (tenant_id, product_id, name, factor_milli, price_minor, is_base) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tid, pid, u.name, u.factor, u.price, i === 0],
      );
      for (const b of u.barcodes) await db.query(`INSERT INTO barcodes (tenant_id, unit_id, code) VALUES ($1,$2,$3)`, [tid, uid, b]);
    }
    await db.query(`INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, note) VALUES ($1,$2,$3,100000,'adjust','رصيد افتتاحي')`, [tid, sid, pid]);
  };
  await product("مياه معدنية 1.5 لتر", drinks, 400, [
    { name: "قنينة", factor: 1000, price: 750, barcodes: ["6191234500011"] },
    { name: "شد 6", factor: 6000, price: 4000, barcodes: ["6191234500028"] },
  ]);
  await product("بيبسي علبة 330 مل", drinks, 900, [
    { name: "علبة", factor: 1000, price: 1500, barcodes: ["6191234500035"] },
    { name: "كرتونة 24", factor: 24000, price: 32000, barcodes: ["6191234500042"] },
  ]);
  await product("حليب طازج 1 لتر", dairy, 2800, [{ name: "علبة", factor: 1000, price: 3500, barcodes: ["6191234500059"] }]);
  await product("ياغورت فراولة", dairy, 600, [{ name: "علبة", factor: 1000, price: 1000, barcodes: ["6191234500066"] }]);
  await product("جبنة مثلثات 8 قطع", dairy, 3200, [{ name: "علبة", factor: 1000, price: 4250, barcodes: ["6191234500073"] }]);
  await product("مكرونة 500 جم", pantry, 900, [
    { name: "كيس", factor: 1000, price: 1250, barcodes: ["6191234500080"] },
    { name: "كرتونة 20", factor: 20000, price: 23000, barcodes: ["6191234500097"] },
  ]);
  await product("زيت زيتون 1 لتر", pantry, 14000, [{ name: "قنينة", factor: 1000, price: 18500, barcodes: ["6191234500103"] }]);
  await product("سكر 1 كجم", pantry, 2600, [{ name: "كيس", factor: 1000, price: 3250, barcodes: ["6191234500110"] }]);
  await product("طماطم", veg, 2000, [{ name: "كيلو", factor: 1000, price: 3500, barcodes: [] }], "00101");
  await product("بطاطا", veg, 1500, [{ name: "كيلو", factor: 1000, price: 2500, barcodes: [] }], "00102");
  await product("موز", veg, 4000, [{ name: "كيلو", factor: 1000, price: 5500, barcodes: [] }], "00103");
  await product("لحم غنمي", meat, 38000, [{ name: "كيلو", factor: 1000, price: 48000, barcodes: [] }], "00201");
  await product("دجاج كامل", meat, 9000, [{ name: "كيلو", factor: 1000, price: 12500, barcodes: [] }], "00202");
}

/** Demos opened before the price checker existed get one too. */
async function addPriceChecker(db: Q) {
  const t = hashToken(DEMO_CHECKER_TOKEN);
  if ((await db.query(`SELECT 1 FROM devices WHERE token_hash = $1`, [t])).rows.length) return;
  await db.query(
    `INSERT INTO devices (tenant_id, store_id, name, prefix, token_hash, kind)
     SELECT tenant_id, store_id, 'قارئ الأسعار', 'PC', $1, 'price_checker' FROM devices ORDER BY created_at LIMIT 1`,
    [t],
  );
}

export const DEMO_PLATFORM = { email: "admin@sale7.ly", password: "platform12345" };

/** The platform side of the demo: its staff login and a handful of other shops in different states. */
async function addPlatform(db: Q) {
  if ((await db.query(`SELECT 1 FROM platform_admins LIMIT 1`)).rows.length) return;
  const aid = (await db.query(
    `INSERT INTO platform_admins (name, email, password_hash) VALUES ('صالح', $1, $2) RETURNING id`,
    [DEMO_PLATFORM.email, await bcrypt.hash(DEMO_PLATFORM.password, 8)],
  )).rows[0].id as string;
  const pay = (tid: string, plan: string, months: number, price: number, monthsAgo: number, method: string) =>
    db.query(
      `INSERT INTO subscription_payments (tenant_id, plan_code, months, amount_minor, method, period_from, period_to, recorded_by, created_at)
       VALUES ($1,$2,$3,$4,$5, now() - make_interval(months => $6), now() - make_interval(months => $6) + make_interval(months => $3), $7, now() - make_interval(months => $6))`,
      [tid, plan, months, price * months, method, monthsAgo, aid],
    );

  const demo = (await db.query(`SELECT id FROM tenants ORDER BY created_at LIMIT 1`)).rows[0].id as string;
  await db.query(`UPDATE tenants SET status = 'active', plan_code = 'pro', phone = '0911111111', paid_until = now() + interval '25 days' WHERE id = $1`, [demo]);
  await pay(demo, "pro", 1, 300000, 0, "bank");

  const others: [string, string, string, string, string, string | null][] = [
    // name, phone, owner email, plan, status, paid_until offset
    ["بقالة النور", "0921234567", "noor@demo.ly", "basic", "trial", "3 days"],
    ["ملحمة الأصيل", "0917654321", "aseel@demo.ly", "basic", "active", "-3 days"],
    ["صيدلية الشفاء", "0945556677", "shifa@demo.ly", "pro", "suspended", "-40 days"],
    ["أسواق الواحة", "0918889990", "waha@demo.ly", "chain", "active", "80 days"],
  ];
  for (const [name, phone, email, plan, status, offset] of others) {
    const tid = (await db.query(
      `INSERT INTO tenants (name, phone, plan_code, status, status_reason, paid_until, created_at) VALUES ($1,$2,$3,$4,$5, now() + $6::interval, now() - interval '70 days') RETURNING id`,
      [name, phone, plan, status, status === "suspended" ? "ما دفعش من شهرين" : null, offset],
    )).rows[0].id as string;
    const sid = (await db.query(`INSERT INTO stores (tenant_id, name) VALUES ($1, 'الفرع الرئيسي') RETURNING id`, [tid])).rows[0].id;
    await db.query(`INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES ($1, 'المالك', $2, 'x', 'owner')`, [tid, email]);
    await db.query(
      `INSERT INTO devices (tenant_id, store_id, name, prefix, token_hash, last_seen_at) VALUES ($1,$2,'كاشير 1','P1',$3, now() - interval '2 hours')`,
      [tid, sid, hashToken(`${email}-device`)],
    );
    if (name === "ملحمة الأصيل") await pay(tid, "basic", 2, 150000, 2, "cash");
    if (name === "أسواق الواحة") await pay(tid, "chain", 3, 700000, 0, "bank");
  }
}

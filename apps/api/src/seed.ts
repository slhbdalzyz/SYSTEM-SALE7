// Demo grocery shop: owner, cashier, one device, a few products (pieces, cartons, weighed items).
import bcrypt from "bcryptjs";
import { createPool, inTx } from "./db";
import { migrate } from "./migrate";
import { hashToken } from "./auth";

const DEMO_DEVICE_TOKEN = "d".repeat(64);

const db = createPool();
await migrate(db);
const exists = await db.query(`SELECT 1 FROM users WHERE email = 'owner@demo.ly'`);
if (exists.rowCount) {
  console.log("demo data already there");
  process.exit(0);
}
await inTx(db, async (tx) => {
  const tid = (await tx.query(`INSERT INTO tenants (name) VALUES ('سوبرماركت التجربة') RETURNING id`)).rows[0].id;
  const sid = (await tx.query(`INSERT INTO stores (tenant_id, name, address, receipt_footer) VALUES ($1,'الفرع الرئيسي','طرابلس','شكراً لزيارتكم') RETURNING id`, [tid])).rows[0].id;
  await tx.query(`INSERT INTO users (tenant_id, name, email, password_hash, pin_hash, role) VALUES ($1,'المالك','owner@demo.ly',$2,$3,'owner')`, [tid, await bcrypt.hash("demo12345", 12), await bcrypt.hash("9999", 10)]);
  await tx.query(`INSERT INTO users (tenant_id, name, pin_hash, role) VALUES ($1,'أحمد الكاشير',$2,'cashier')`, [tid, await bcrypt.hash("1234", 10)]);
  await tx.query(`INSERT INTO devices (tenant_id, store_id, name, prefix, token_hash) VALUES ($1,$2,'كاشير 1','P1',$3)`, [tid, sid, hashToken(DEMO_DEVICE_TOKEN)]);
  const cat = async (n: string) => (await tx.query(`INSERT INTO categories (tenant_id, name) VALUES ($1,$2) RETURNING id`, [tid, n])).rows[0].id;
  const drinks = await cat("مشروبات");
  const dairy = await cat("ألبان");
  const veg = await cat("خضرة وفواكه");
  const meat = await cat("لحوم");
  const product = async (
    name: string, categoryId: string, costMinor: number, units: { name: string; factor: number; price: number; barcodes: string[] }[],
    weighted = false, scaleCode: string | null = null, stockMilli = 100000,
  ) => {
    const pid = (await tx.query(
      `INSERT INTO products (tenant_id, name, category_id, is_weighted, scale_code, cost_minor, min_stock_milli) VALUES ($1,$2,$3,$4,$5,$6,10000) RETURNING id`,
      [tid, name, categoryId, weighted, scaleCode, costMinor],
    )).rows[0].id;
    for (const [i, u] of units.entries()) {
      const uid = (await tx.query(
        `INSERT INTO product_units (tenant_id, product_id, name, factor_milli, price_minor, is_base) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tid, pid, u.name, u.factor, u.price, i === 0],
      )).rows[0].id;
      for (const b of u.barcodes) await tx.query(`INSERT INTO barcodes (tenant_id, unit_id, code) VALUES ($1,$2,$3)`, [tid, uid, b]);
    }
    await tx.query(`INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, note) VALUES ($1,$2,$3,$4,'adjust','رصيد افتتاحي')`, [tid, sid, pid, stockMilli]);
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
  await product("طماطم", veg, 2000, [{ name: "كيلو", factor: 1000, price: 3500, barcodes: [] }], true, "00101");
  await product("بطاطا", veg, 1500, [{ name: "كيلو", factor: 1000, price: 2500, barcodes: [] }], true, "00102");
  await product("لحم غنمي", meat, 38000, [{ name: "كيلو", factor: 1000, price: 48000, barcodes: [] }], true, "00201");
});
console.log("demo data created");
console.log("owner login: owner@demo.ly / demo12345");
console.log("cashier PIN: 1234 (أحمد) — owner PIN: 9999");
console.log(`demo device token: ${DEMO_DEVICE_TOKEN}`);
await db.end();

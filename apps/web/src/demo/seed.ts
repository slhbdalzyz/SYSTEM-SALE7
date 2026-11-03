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
    await addPlatform(db);
    await addSuppliers(db);
    await addBranch(db);
    await addOffers(db);
    return addOwnerDemo(db);
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
  await addSuppliers(db);
  await addBranch(db);
  await addOffers(db);
  await addOwnerDemo(db);
}

/**
 * A week of past sales so the owner's phone has a chart to show, this month's expenses, and
 * a few alerts as they would have come in. Sums are made here the same way the server makes them.
 */
async function addOwnerDemo(db: Q) {
  if ((await db.query(`SELECT 1 FROM expenses LIMIT 1`)).rows.length) return;
  const { tid, sid, did } = (await db.query(`SELECT tenant_id AS tid, store_id AS sid, id AS did FROM devices WHERE kind = 'pos' ORDER BY created_at LIMIT 1`)).rows[0];
  const uid = (await db.query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'cashier' LIMIT 1`, [tid])).rows[0].id;
  const items = (await db.query(
    `SELECT p.id AS pid, u.id AS uid, p.name, u.price_minor, p.cost_minor FROM products p JOIN product_units u ON u.product_id = p.id AND u.is_base
     -- Pepsi and milk are already left low on purpose, for the reorder list.
     WHERE p.tenant_id = $1 AND NOT p.is_weighted AND p.name NOT IN ('بيبسي علبة 330 مل', 'حليب طازج 1 لتر') ORDER BY p.name`,
    [tid],
  )).rows;
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  // Built here and sent as four statements: one query per row would take minutes in the browser.
  const sales: { id: string; number: string; total: number; mins: number }[] = [];
  const lines: { sale: string; pid: string; uid: string; name: string; qty: number; price: number; total: number; cost: number; mins: number }[] = [];
  // Fewer sales on some days than others, as a grocery would see.
  for (let daysAgo = 7; daysAgo >= 0; daysAgo--) {
    const count = daysAgo === 0 ? 9 : 12 + rnd(10);
    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID();
      const mins = daysAgo === 0 ? 20 + i * 23 : daysAgo * 1440 - 480 + rnd(720);
      let total = 0;
      for (let n = 1 + rnd(3); n > 0; n--) {
        const it = items[rnd(items.length)];
        const qty = (1 + rnd(2)) * 1000;
        const amount = Math.round((it.price_minor * qty) / 1000);
        total += amount;
        lines.push({ sale: id, pid: it.pid, uid: it.uid, name: it.name, qty, price: it.price_minor, total: amount, cost: Math.round((it.cost_minor * qty) / 1000), mins });
      }
      sales.push({ id, number: `D-${String(sales.length + 1).padStart(5, "0")}`, total, mins });
    }
  }
  await db.query(
    `INSERT INTO sales (id, tenant_id, store_id, device_id, user_id, number, subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, change_minor, created_at)
     SELECT x.id, $2, $3, $4, $5, x.number, x.total, 0, 0, x.total, x.total, 0, now() - make_interval(mins => x.mins)
     FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, number text, total bigint, mins int)`,
    [JSON.stringify(sales), tid, sid, did, uid],
  );
  await db.query(
    `INSERT INTO payments (tenant_id, sale_id, method, amount_minor) SELECT $2, x.id, 'cash', x.total FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, total bigint)`,
    [JSON.stringify(sales), tid],
  );
  await db.query(
    `INSERT INTO sale_lines (tenant_id, sale_id, product_id, unit_id, name, qty_milli, price_minor, discount_minor, tax_minor, total_minor, cost_minor)
     SELECT $2, x.sale, x.pid, x.uid, x.name, x.qty, x.price, 0, 0, x.total, x.cost
     FROM jsonb_to_recordset($1::jsonb) AS x(sale uuid, pid uuid, uid uuid, name text, qty bigint, price bigint, total bigint, cost bigint)`,
    [JSON.stringify(lines), tid],
  );
  await db.query(
    `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, created_at)
     SELECT $2, $3, x.pid, -x.qty, 'sale', x.sale, now() - make_interval(mins => x.mins)
     FROM jsonb_to_recordset($1::jsonb) AS x(sale uuid, pid uuid, qty bigint, mins int)`,
    [JSON.stringify(lines), tid, sid],
  );
  const owner = (await db.query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1`, [tid])).rows[0].id;
  for (const [category, amount, day, note] of [
    ["إيجار", 350000, "first", "إيجار المحل"], ["كهرباء", 85000, "-3", null], ["نقل", 25000, "0", "توصيل بضاعة"],
  ] as const) {
    await db.query(
      `INSERT INTO expenses (tenant_id, store_id, category, amount_minor, note, spent_on, user_id)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $6 = 'first' THEN date_trunc('month', now() AT TIME ZONE 'Africa/Tripoli')::date ELSE (now() AT TIME ZONE 'Africa/Tripoli')::date + $6::int END, $7)`,
      [tid, sid, category, amount, note, day, owner],
    );
  }
  for (const [kind, title, body, ago, read] of [
    ["cash_diff", "الدرج ناقص 12.500 د.ل", "أحمد الكاشير قفل الوردية على كاشير 1", "26 hours", true],
    ["big_discount", "خصم 25.000 د.ل", "أحمد الكاشير عطى خصم على الفاتورة P1-000231", "5 hours", false],
    ["low_stock", "قرب يخلص: بيبسي علبة 330 مل", "باقي 6 في الفرع الرئيسي (الحد 10)", "3 hours", false],
    ["low_stock", "قرب يخلص: حليب طازج 1 لتر", "باقي 6 في الفرع الرئيسي (الحد 10)", "40 minutes", false],
  ] as const) {
    await db.query(
      `INSERT INTO alerts (tenant_id, store_id, kind, title, body, created_at, read_at) VALUES ($1,$2,$3,$4,$5, now() - $6::interval, CASE WHEN $7 THEN now() END)`,
      [tid, sid, kind, title, body, ago, read],
    );
  }
}

/** A buy-2-get-1 on yoghurt, a 3-for-10 on pasta, and 10% off meat on Fridays. */
async function addOffers(db: Q) {
  if ((await db.query(`SELECT 1 FROM offers LIMIT 1`)).rows.length) return;
  const tid = (await db.query(`SELECT tenant_id FROM devices ORDER BY created_at LIMIT 1`)).rows[0].tenant_id;
  const pid = async (name: string) => (await db.query(`SELECT id FROM products WHERE tenant_id = $1 AND name = $2`, [tid, name])).rows[0].id;
  const meat = (await db.query(`SELECT id FROM categories WHERE tenant_id = $1 AND name = 'لحوم'`, [tid])).rows[0].id;
  await db.query(`INSERT INTO offers (tenant_id, name, kind, buy_qty, get_qty, product_ids) VALUES ($1, 'ياغورت 2+1', 'buy_get', 2, 1, $2)`, [tid, [await pid("ياغورت فراولة")]]);
  await db.query(
    `INSERT INTO offers (tenant_id, name, kind, bundle_qty, bundle_price_minor, product_ids, ends_at) VALUES ($1, 'مكرونة 3 بـ 3.5', 'bundle', 3, 3500, $2, now() + interval '10 days')`,
    [tid, [await pid("مكرونة 500 جم")]],
  );
  await db.query(`INSERT INTO offers (tenant_id, name, kind, percent_bp, category_ids, days) VALUES ($1, 'جمعة اللحم 10%', 'percent', 1000, $2, '{5}')`, [tid, [meat]]);
}

/** A second branch with some stock, and a transfer from the main branch on its way there. */
async function addBranch(db: Q) {
  const { tid, sid } = (await db.query(`SELECT tenant_id AS tid, store_id AS sid FROM devices ORDER BY created_at LIMIT 1`)).rows[0];
  if ((await db.query(`SELECT count(*)::int AS n FROM stores WHERE tenant_id = $1`, [tid])).rows[0].n > 1) return;
  const b2 = (await db.query(`INSERT INTO stores (tenant_id, name, address, receipt_footer) VALUES ($1,'فرع حي الأندلس','طرابلس - حي الأندلس','شكراً لزيارتكم') RETURNING id`, [tid])).rows[0].id;
  await db.query(
    `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, note) SELECT $1, $2, id, 30000, 'adjust', 'رصيد افتتاحي' FROM products WHERE tenant_id = $1`,
    [tid, b2],
  );
  const tr = (await db.query(`INSERT INTO stock_transfers (tenant_id, number, from_store_id, to_store_id, note) VALUES ($1, 1, $2, $3, 'مع السايق') RETURNING id`, [tid, sid, b2])).rows[0].id;
  for (const [name, qty] of [["زيت زيتون 1 لتر", 12000], ["مكرونة 500 جم", 40000]] as const) {
    const p = (await db.query(`SELECT id FROM products WHERE tenant_id = $1 AND name = $2`, [tid, name])).rows[0].id;
    await db.query(`INSERT INTO stock_transfer_lines (tenant_id, transfer_id, product_id, name, qty_milli) VALUES ($1,$2,$3,$4,$5)`, [tid, tr, p, name, qty]);
    await db.query(`INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note) VALUES ($1,$2,$3,$4,'transfer',$5,'تحويل 1 (إرسال)')`, [tid, sid, p, -qty, tr]);
  }
}

/** Two suppliers, one bought-on-credit invoice, and a couple of items running low so «النواقص» has something. */
async function addSuppliers(db: Q) {
  if ((await db.query(`SELECT 1 FROM suppliers LIMIT 1`)).rows.length) return;
  const { tid, sid } = (await db.query(`SELECT tenant_id AS tid, store_id AS sid FROM devices ORDER BY created_at LIMIT 1`)).rows[0];
  const sup = async (name: string, phone: string) =>
    (await db.query(`INSERT INTO suppliers (tenant_id, name, phone) VALUES ($1,$2,$3) RETURNING id`, [tid, name, phone])).rows[0].id as string;
  const drinks = await sup("شركة المشروبات الوطنية", "0214441122");
  await sup("مخازن الألبان", "0913332211");
  const unit = async (name: string) =>
    (await db.query(`SELECT u.id, u.product_id, u.factor_milli FROM product_units u JOIN products p ON p.id = u.product_id WHERE p.tenant_id = $1 AND u.name = $2 ORDER BY u.factor_milli DESC LIMIT 1`, [tid, name])).rows[0];
  const carton = await unit("كرتونة 24");
  const inv = (await db.query(
    `INSERT INTO purchase_invoices (tenant_id, store_id, supplier_id, supplier_ref, invoice_date, total_minor, created_at)
     VALUES ($1,$2,$3,'F-1021', current_date - 5, 108000, now() - interval '5 days') RETURNING id`,
    [tid, sid, drinks],
  )).rows[0].id as string;
  await db.query(
    `INSERT INTO purchase_lines (tenant_id, invoice_id, product_id, unit_id, name, unit_name, qty_milli, unit_cost_minor, total_minor)
     SELECT $1, $2, $3, $4, p.name, 'كرتونة 24', 5000, 21600, 108000 FROM products p WHERE p.id = $3`,
    [tid, inv, carton.product_id, carton.id],
  );
  await db.query(`INSERT INTO supplier_payments (tenant_id, supplier_id, invoice_id, amount_minor, method, created_at) VALUES ($1,$2,$3,50000,'cash', now() - interval '5 days')`, [tid, drinks, inv]);
  // Sell most of the stock of two items so they show up as running low.
  for (const name of ["بيبسي علبة 330 مل", "حليب طازج 1 لتر"]) {
    await db.query(
      `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, note) SELECT $1, $2, id, -94000, 'adjust', 'تجربة: بيع' FROM products WHERE tenant_id = $1 AND name = $3`,
      [tid, sid, name],
    );
  }
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

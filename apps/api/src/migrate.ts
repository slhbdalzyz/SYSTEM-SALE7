import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPool, type Db } from "./db";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate(db: Db) {
  // Two servers starting together must not both migrate: the second waits for the first.
  const lock = await db.connect();
  await lock.query(`SELECT pg_advisory_lock(73100)`);
  try {
    await apply(db);
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(73100)`);
    lock.release();
  }
}

async function apply(db: Db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query(sql);
      await c.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      await c.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}

/**
 * The first person who runs the platform, from PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD,
 * created only while there is nobody yet. Later admins come from `platform:admin`.
 */
export async function bootstrapPlatformAdmin(db: Db) {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !password) return;
  if ((await db.query(`SELECT 1 FROM platform_admins LIMIT 1`)).rowCount) return;
  if (password.length < 10) throw new Error("PLATFORM_ADMIN_PASSWORD must be at least 10 characters");
  const bcrypt = (await import("bcryptjs")).default;
  await db.query(`INSERT INTO platform_admins (name, email, password_hash) VALUES ('مدير المنصة', $1, $2)`, [email, await bcrypt.hash(password, 12)]);
  console.log(`platform admin created: ${email}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = createPool();
  migrate(db)
    .then(() => bootstrapPlatformAdmin(db))
    .then(() => db.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

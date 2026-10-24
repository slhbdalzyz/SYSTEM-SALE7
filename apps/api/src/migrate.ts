import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPool, type Db } from "./db";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate(db: Db) {
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = createPool();
  migrate(db)
    .then(() => db.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

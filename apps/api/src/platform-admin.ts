// Creates (or resets the password of) someone who runs the platform:
//   PASSWORD='…' pnpm --filter @pos/api platform:admin admin@example.ly "الاسم"
import bcrypt from "bcryptjs";
import { createPool } from "./db";

const [email, name = "مدير المنصة"] = process.argv.slice(2);
const password = process.env.PASSWORD;
if (!email || !password || password.length < 10) {
  console.error("usage: PASSWORD=<at least 10 characters> platform:admin <email> [name]");
  process.exit(1);
}
const db = createPool();
await db.query(
  `INSERT INTO platform_admins (name, email, password_hash) VALUES ($1, $2, $3)
   ON CONFLICT (email) DO UPDATE SET password_hash = $3, active = true`,
  [name, email.toLowerCase(), await bcrypt.hash(password, 12)],
);
console.log(`platform admin ready: ${email}`);
await db.end();

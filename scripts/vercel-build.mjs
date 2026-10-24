// Builds a site for Vercel with the Build Output API. With POS_DEMO=1 it is the browser-only
// demo (no server, no database). Otherwise it is the real service:
//   1. applies database migrations (and creates the first platform admin, if asked),
//   2. builds the web app as static files,
//   3. bundles the API into one serverless function under /api.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const run = (cmd, env = {}) => execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
const out = ".vercel/output";
rmSync(out, { recursive: true, force: true });

if (process.env.POS_DEMO === "1") {
  run("pnpm --filter @pos/web exec vite build", { VITE_DEMO: "1" });
  cpSync("apps/web/dist-demo", `${out}/static`, { recursive: true });
  writeFileSync(
    `${out}/config.json`,
    JSON.stringify({
      version: 3,
      routes: [{ src: "^/assets/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true }, { handle: "filesystem" }],
    }),
  );
  console.log("demo output ready");
  process.exit(0);
}

// Migrations need a direct connection, not the pooler.
const directUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL;
if (directUrl) run("pnpm --filter @pos/api migrate", { DATABASE_URL: directUrl });
else console.warn("No DATABASE_URL: skipping migrations. The API will not work until a database is connected.");
if (!process.env.JWT_SECRET) console.warn("No JWT_SECRET: the API will refuse to start.");

run("pnpm --filter @pos/web exec vite build", { VITE_API_URL: "/api", VITE_DEMO: "" });
cpSync("apps/web/dist", `${out}/static`, { recursive: true });

const fn = `${out}/functions/api.func`;
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: ["apps/api/src/vercel.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: `${fn}/index.mjs`,
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
});
writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({ runtime: "nodejs20.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: 30 }));

writeFileSync(
  `${out}/config.json`,
  JSON.stringify({
    version: 3,
    routes: [
      { src: "^/api(/.*)?$", dest: "/api" },
      { src: "^/assets/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
      { handle: "filesystem" },
      // The app decides what to show from the URL (?app=platform, ?screen=display).
      { src: "/(.*)", dest: "/index.html" },
    ],
  }),
);
console.log("vercel output ready");

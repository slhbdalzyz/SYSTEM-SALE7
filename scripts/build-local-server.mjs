// Builds the local edition's server for the Windows app, into apps/desktop/src-tauri/server/:
//   server.mjs     the API, bundled into one file
//   migrations/    the database's SQL files, applied on start
//   node_modules/@electric-sql/pglite   PostgreSQL in WebAssembly (loads its .wasm next to itself)
//   web/           the web app, for the shop's other devices
//   node.exe       added by the Windows build (NODE_EXE=path), the runtime the app starts it with
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { build } from "esbuild";

const out = "apps/desktop/src-tauri/server";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ["apps/api/src/local/main.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: `${out}/server.mjs`,
  external: ["@electric-sql/pglite", "pg-native"],
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
  // The platform's public licence key, fetched by the Windows build from GET /api/licenses/public-key.
  define: { "process.env.POS_LICENSE_PUBLIC_KEY": JSON.stringify(process.env.LICENSE_PUBLIC_KEY ?? "") },
});
if (!process.env.LICENSE_PUBLIC_KEY) console.warn("No LICENSE_PUBLIC_KEY: this build cannot activate licences (the 14-day trial still works).");
cpSync("apps/api/migrations", `${out}/migrations`, { recursive: true });
// The web app, served to the shop's other devices when the shop network is on.
if (existsSync("apps/web/dist/index.html")) cpSync("apps/web/dist", `${out}/web`, { recursive: true });
else console.warn("No apps/web/dist: build the web app first (VITE_LOCAL=1) for the shop network.");

// pnpm keeps the package behind a link in apps/api/node_modules; copy what it points to.
const pglite = realpathSync("apps/api/node_modules/@electric-sql/pglite");
// Without the source maps, type files and optional extensions (the schema uses none), it is a third the size.
const skip = /(\.map|\.d\.ts|\.d\.cts|\.tar\.gz)$/;
cpSync(pglite, `${out}/node_modules/@electric-sql/pglite`, { recursive: true, dereference: true, filter: (src) => !skip.test(src) });

if (process.env.NODE_EXE) {
  if (!existsSync(process.env.NODE_EXE)) throw new Error(`NODE_EXE not found: ${process.env.NODE_EXE}`);
  cpSync(process.env.NODE_EXE, `${out}/node.exe`);
}
console.log(`local server ready in ${out}`);

// Builds the local edition's server for the Windows app, into apps/desktop/src-tauri/server/:
//   server.mjs     the API, bundled into one file
//   migrations/    the database's SQL files, applied on start
//   node_modules/@electric-sql/pglite   PostgreSQL in WebAssembly (loads its .wasm next to itself)
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
});
cpSync("apps/api/migrations", `${out}/migrations`, { recursive: true });

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

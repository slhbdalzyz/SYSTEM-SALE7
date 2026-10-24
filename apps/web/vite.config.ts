import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

const demo = process.env.VITE_DEMO === "1";
const shims = fileURLToPath(new URL("./src/demo/shims.ts", import.meta.url));

export default defineConfig({
  // The demo is served from any folder (a file host or a shared link), so its asset paths are relative.
  base: demo ? "./" : "/",
  build: demo ? { outDir: "dist-demo", chunkSizeWarningLimit: 4000 } : undefined,
  // The demo runs the API's route code in the page; these two Node modules get browser stand-ins.
  resolve: { alias: { "node:crypto": shims, pg: shims } },
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
  plugins: [
    react(),
    // Caches the app itself so the cashier screen opens with no internet.
    VitePWA({
      disable: demo,
      registerType: "autoUpdate",
      manifest: {
        name: "نظام نقاط البيع",
        short_name: "POS",
        lang: "ar",
        dir: "rtl",
        display: "standalone",
        background_color: "#0f172a",
        theme_color: "#0f766e",
        icons: [],
      },
      workbox: { navigateFallbackDenylist: [/^\/api/] },
    }),
  ],
  server: {
    proxy: { "/api": { target: "http://localhost:3000", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});

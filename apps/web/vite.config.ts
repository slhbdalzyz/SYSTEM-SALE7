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
        short_name: "المحل",
        description: "الكاشير، ولصاحب المحل: مبيعات اليوم والتنبيهات من التلفون",
        lang: "ar",
        dir: "rtl",
        start_url: "./",
        display: "standalone",
        background_color: "#f1f5f9",
        theme_color: "#0f766e",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      includeAssets: ["apple-touch-icon.png", "icon.svg"],
      // push-sw.js adds the phone notifications to the generated service worker.
      workbox: { navigateFallbackDenylist: [/^\/api/], importScripts: ["push-sw.js"] },
    }),
  ],
  server: {
    proxy: { "/api": { target: "http://localhost:3000", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});

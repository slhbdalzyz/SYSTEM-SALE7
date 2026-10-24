import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // Caches the app itself so the cashier screen opens with no internet.
    VitePWA({
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

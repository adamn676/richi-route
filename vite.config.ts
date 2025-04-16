import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/ors-api": {
        target: "https://api.openrouteservice.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ors-api/, ""),
      },
    },
  },
});

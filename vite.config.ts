import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  resolve: {
    alias: {
      "@/platform": path.resolve(__dirname, "src/platform"),
      "@/modules": path.resolve(__dirname, "src/modules"),
      "@/components": path.resolve(__dirname, "src/components"),
      "@/app": path.resolve(__dirname, "src/app"),
      "@/styles": path.resolve(__dirname, "src/styles"),
    },
  },
}));

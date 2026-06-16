import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@/platform": path.resolve(__dirname, "src/platform"),
      "@/modules": path.resolve(__dirname, "src/modules"),
      "@/components": path.resolve(__dirname, "src/components"),
      "@/app": path.resolve(__dirname, "src/app"),
      "@/styles": path.resolve(__dirname, "src/styles"),
      "@/assets": path.resolve(__dirname, "src/assets"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});

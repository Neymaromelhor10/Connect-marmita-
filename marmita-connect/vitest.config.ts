import path from "node:path";
import { defineConfig } from "vitest/config";

// Pure unit tests do not start the app, contact Cloud, or load its Vite plugins.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts", "tests/**/*.test.ts"] },
});
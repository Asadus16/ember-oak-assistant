import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "evals/**/*.test.ts"] },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // `server-only` throws outside the Next.js server bundle, so tests use an empty module.
      "server-only": path.resolve(import.meta.dirname, "tests/empty.ts"),
    },
  },
});

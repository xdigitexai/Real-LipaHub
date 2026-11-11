import { defineConfig } from "vitest/config";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, ".env") });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Never talk to real AI providers from tests (stubs are opt-in per test).
    setupFiles: ["tests/setup.ts"],
    // DB integration tests share state — run files serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});

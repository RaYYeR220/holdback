import { defineConfig } from "vitest/config";

// Own config so vitest never loads vite.config.ts (a newer Vite than vitest's own).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ["test/global-setup.ts"],
  },
});

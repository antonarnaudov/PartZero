import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against the workspace sources so `pnpm test` works without building @aicad/ir-types first.
    alias: {
      "@aicad/ir-types": fileURLToPath(new URL("../ir-types/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});

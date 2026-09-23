import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against the workspace sources so `pnpm test` works without building dependencies first.
    alias: {
      "@aicad/ir-types": fileURLToPath(new URL("../ir-types/src/index.ts", import.meta.url)),
      "@aicad/cadscript": fileURLToPath(new URL("../cadscript/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});

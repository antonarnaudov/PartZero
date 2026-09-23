import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against the workspace sources so `pnpm test` works without building the dependencies first.
    alias: {
      "@aicad/ir-types": src("ir-types"),
      "@aicad/cadscript": src("cadscript"),
      "@aicad/evals": src("evals"),
      "@aicad/llm-gateway": src("llm-gateway"),
      "@aicad/agent-tools": src("agent-tools"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});

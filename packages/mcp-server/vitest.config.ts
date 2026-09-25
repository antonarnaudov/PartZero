import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // In-process tests run against the workspace sources; the spawned shim runs from dist/ (the test script builds it).
    alias: {
      "@aicad/ir-types": src("ir-types"),
      "@aicad/cadscript": src("cadscript"),
      "@aicad/evals": src("evals"),
      "@aicad/llm-gateway": src("llm-gateway"),
      "@aicad/agent-tools": src("agent-tools"),
      "@aicad/model-ops": src("model-ops"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});

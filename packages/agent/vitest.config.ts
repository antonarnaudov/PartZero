import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string, entry = "index.ts") => fileURLToPath(new URL(`../${pkg}/src/${entry}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against the workspace sources so `pnpm test` works without building the dependencies first.
    // Exact matches: `@aicad/llm-gateway` must not swallow its `/cli` subpath.
    // `@aicad/mcp-server` is a test-only resolution (CLI runtime tests run the real broker; the spawned
    // shim itself runs from packages/mcp-server/dist, built by that package).
    alias: [
      { find: /^@aicad\/ir-types$/, replacement: src("ir-types") },
      { find: /^@aicad\/cadscript$/, replacement: src("cadscript") },
      { find: /^@aicad\/evals$/, replacement: src("evals") },
      { find: /^@aicad\/llm-gateway$/, replacement: src("llm-gateway") },
      { find: /^@aicad\/llm-gateway\/cli$/, replacement: src("llm-gateway", "cli/index.ts") },
      { find: /^@aicad\/agent-tools$/, replacement: src("agent-tools") },
      { find: /^@aicad\/model-ops$/, replacement: src("model-ops") },
      { find: /^@aicad\/mcp-server$/, replacement: src("mcp-server") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});

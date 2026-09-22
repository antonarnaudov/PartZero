import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateAll, PACKAGE_ROOT, REPO_ROOT } from "../scripts/generate.js";

describe("generated files", () => {
  for (const file of generateAll(REPO_ROOT)) {
    it(`${file.path} is up to date with the forge-ir schemas (run \`pnpm --filter @aicad/ir-types run generate\`)`, () => {
      let onDisk: string;
      try {
        onDisk = readFileSync(join(PACKAGE_ROOT, file.path), "utf8");
      } catch {
        throw new Error(`${file.path} is missing; run \`pnpm --filter @aicad/ir-types run generate\``);
      }
      expect(onDisk, `${file.path} is stale; run \`pnpm --filter @aicad/ir-types run generate\``).toBe(file.content);
    });
  }
});

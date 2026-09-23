/**
 * MakerBench reference solutions (CadScript v0 sources) are CadScript v1 sources: each compiles
 * with the v1 compiler to the migration of its v0 compile, type-checks against @aicad/std v1, and
 * prints back to a fixed point.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile as compileV0 } from "../../src/index.js";
import { compileV1 } from "../../src/v1/compile.js";
import { migrateV0ToV1 } from "../../src/v1/migrate.js";
import { printV1 } from "../../src/v1/print.js";
import { typecheckV1 } from "../../src/v1/typecheck.js";
import { MAKERBENCH, readText } from "./helpers.js";

const refs = readdirSync(MAKERBENCH)
  .filter((f) => f.endsWith(".cad.ts"))
  .sort();

describe("MakerBench references under CadScript v1", () => {
  it("has the references", () => {
    expect(refs.length).toBeGreaterThanOrEqual(60);
  });

  for (const f of refs) {
    it(f, () => {
      const source = readText(join(MAKERBENCH, f));
      const v0 = compileV0(source);
      const r = compileV1(source);
      expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)).toEqual([]);
      expect(v0.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(v0.ir).toBeTruthy();
      expect(r.ir).toStrictEqual(migrateV0ToV1(v0.ir!));
      expect(typecheckV1(source)).toEqual([]);
      const printed = printV1(r.ir!);
      expect(compileV1(printed, { base: r.ir! }).ir).toStrictEqual(r.ir);
      expect(typecheckV1(printed)).toEqual([]);
    });
  }
});

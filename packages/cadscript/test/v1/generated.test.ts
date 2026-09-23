/**
 * Generated files of CadScript v1, kept in sync by this test (Vitest file snapshots;
 * `pnpm --filter @aicad/cadscript run generate` rewrites them):
 * - `src/generated/std-v1-dts.ts` embeds `std/v1/index.d.ts`;
 * - `corpus/v1/cadscript/<stem>.cad.ts` are the CadScript twins of `corpus/v1/programs/<stem>.json`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { v1 as irV1 } from "@aicad/ir-types";
import { IR_RESERVED_NAMES } from "../../src/syntax.js";
import { compileV1 } from "../../src/v1/compile.js";
import { printV1 } from "../../src/v1/print.js";
import { BUILTINS_V1, RESERVED_NAMES_V0, RESERVED_NAMES_V1 } from "../../src/v1/syntax.js";
import { stdV1LibDiagnostics, typecheckV1 } from "../../src/v1/typecheck.js";
import { readJson, REPO_ROOT, V1_CADSCRIPT, v1Programs } from "./helpers.js";

function stdV1DtsModule(dts: string): string {
  return `// Code generated from std/v1/index.d.ts by test/v1/generated.test.ts. DO NOT EDIT.
// Regenerate with \`pnpm --filter @aicad/cadscript run generate\`.

/**
 * The text of \`std/v1/index.d.ts\`: the \`@aicad/std\` v1 declarations (CadScript v1). Mount it as the
 * \`@aicad/std\` module for editors, e.g. Monaco: \`addExtraLib(STD_V1_DTS, "file:///node_modules/@aicad/std/index.d.ts")\`.
 */
export const STD_V1_DTS: string = ${JSON.stringify(dts)};
`;
}

describe("generated files, v1 (regenerate: pnpm --filter @aicad/cadscript run generate)", () => {
  it("src/generated/std-v1-dts.ts embeds std/v1/index.d.ts", async () => {
    const dts = readFileSync(new URL("../../std/v1/index.d.ts", import.meta.url), "utf8");
    await expect(stdV1DtsModule(dts)).toMatchFileSnapshot("../../src/generated/std-v1-dts.ts");
  });

  it("the std v1 declarations type-check on their own", () => {
    expect(stdV1LibDiagnostics()).toEqual([]);
  });

  for (const p of v1Programs()) {
    it(`corpus/v1/cadscript/${p.stem}.cad.ts is the CadScript twin of corpus/v1/programs/${p.stem}.json`, async () => {
      const source = printV1(p.ir);
      await expect(source).toMatchFileSnapshot(join(V1_CADSCRIPT, `${p.stem}.cad.ts`));
      expect(compileV1(source, { base: p.ir }).ir).toStrictEqual(p.ir);
      expect(typecheckV1(source)).toEqual([]);
    });
  }
});

describe("forge-ir constants mirror (ir-v1.constants.json)", () => {
  const constants = readJson(join(REPO_ROOT, "forge/crates/forge-ir/schema/ir-v1.constants.json")) as {
    RESERVED_NAMES: string[];
    RESERVED_NAMES_V0: string[];
    RESERVED_NAMES_V1_BUILTINS: string[];
    ERROR_CODES: Record<string, unknown>;
  };

  it("v1 RESERVED_NAMES (parameter names) equals forge-ir's RESERVED_NAMES", () => {
    expect([...RESERVED_NAMES_V1].sort()).toEqual([...constants.RESERVED_NAMES].sort());
  });

  it("the v0 reserved list (feature names; v0 CadScript) equals RESERVED_NAMES_V0", () => {
    expect([...RESERVED_NAMES_V0].sort()).toEqual([...constants.RESERVED_NAMES_V0].sort());
    expect([...IR_RESERVED_NAMES].sort()).toEqual([...constants.RESERVED_NAMES_V0].sort());
  });

  it("@aicad/std v1 exports exactly the v0 builtins plus RESERVED_NAMES_V1_BUILTINS", () => {
    const v0Builtins = constants.RESERVED_NAMES_V0.filter((n) => !["break", "case"].includes(n)).slice(-12);
    expect(BUILTINS_V1).toEqual([...v0Builtins, ...constants.RESERVED_NAMES_V1_BUILTINS]);
    const dts = readFileSync(new URL("../../std/v1/index.d.ts", import.meta.url), "utf8");
    for (const b of BUILTINS_V1) expect(dts, b).toMatch(new RegExp(`export declare (function|const) ${b.replace(/[$]/g, "\\$")}\\b`));
  });

  it("the TS constants package agrees", () => {
    expect([...irV1.RESERVED_NAMES]).toEqual(constants.RESERVED_NAMES);
  });
});

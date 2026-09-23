/**
 * Generated files, kept in sync by this test (Vitest file snapshots):
 * - `src/generated/std-dts.ts` embeds `std/index.d.ts` as a string (so `typecheck` needs no file system);
 * - `corpus/cadscript/*.cad.ts` are the canonical prints of `corpus/programs/*.json`.
 *
 * `pnpm --filter @aicad/cadscript run generate` runs this file with `--update` to rewrite them;
 * a plain `vitest run` fails when any of them is stale.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, print, typecheck } from "../src/index.js";
import { CORPUS_CADSCRIPT, corpusPrograms } from "./helpers.js";

function stdDtsModule(dts: string): string {
  return `// Code generated from std/index.d.ts by test/generated-files.test.ts. DO NOT EDIT.
// Regenerate with \`pnpm --filter @aicad/cadscript run generate\`.

/**
 * The text of \`std/index.d.ts\`: the \`@aicad/std\` declarations. Mount it as a virtual module for
 * editors, e.g. Monaco: \`addExtraLib(STD_DTS, "file:///node_modules/@aicad/std/index.d.ts")\`.
 */
export const STD_DTS: string = ${JSON.stringify(dts)};
`;
}

describe("generated files (regenerate: pnpm --filter @aicad/cadscript run generate)", () => {
  it("src/generated/std-dts.ts embeds std/index.d.ts", async () => {
    const dts = readFileSync(new URL("../std/index.d.ts", import.meta.url), "utf8");
    await expect(stdDtsModule(dts)).toMatchFileSnapshot("../src/generated/std-dts.ts");
  });

  for (const { stem, ir } of corpusPrograms()) {
    it(`corpus/cadscript/${stem}.cad.ts is the printed corpus/programs/${stem}.json`, async () => {
      const source = print(ir);
      await expect(source).toMatchFileSnapshot(`${CORPUS_CADSCRIPT}${stem}.cad.ts`);
      // …and that file is valid CadScript that type-checks and compiles back to the program.
      expect(compile(source, { base: ir }).ir).toStrictEqual(ir);
      expect(typecheck(source)).toEqual([]);
    });
  }
});

import { IR_RESERVED_NAMES } from "../src/syntax.js";
import { readFileSync as readConstants } from "node:fs";
import { fileURLToPath as toPath } from "node:url";

describe("forge-ir constants mirror", () => {
  // SPEC-v1 §9.3: CadScript reads the reserved names from ir-v1.constants.json. The v0 compiler's
  // list (feature names of v0 and migrated documents) is its RESERVED_NAMES_V0; the v1 list is
  // checked in test/v1/generated.test.ts.
  it("IR_RESERVED_NAMES equals forge-ir RESERVED_NAMES_V0 (ir-v1.constants.json)", () => {
    const path = toPath(new URL("../../../forge/crates/forge-ir/schema/ir-v1.constants.json", import.meta.url));
    const constants = JSON.parse(readConstants(path, "utf8")) as { RESERVED_NAMES_V0: string[] };
    expect([...IR_RESERVED_NAMES].sort()).toEqual([...constants.RESERVED_NAMES_V0].sort());
  });
});

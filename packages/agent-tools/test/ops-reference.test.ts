/**
 * The op agent's feature reference is executable: every worked recipe runs, call by call, through
 * the op tools on the real Forge engine; no call is refused and no feature fails at the end.
 */
import { blankDocument, MemoryOpsHost } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import { OPS_RECIPES, opsReference } from "../src/ops-reference.js";
import { opsRegistry, OPS_TOOLS } from "../src/ops.js";
import { forgeEngine, HAS_WASM } from "./forge-engine.js";

const it_ = HAS_WASM ? it : it.skip;

beforeAll(async () => {
  if (HAS_WASM) await forgeEngine();
}, 60_000);

describe("the ops reference", () => {
  it("names only tools that exist and shows every recipe", () => {
    const text = opsReference();
    for (const r of OPS_RECIPES) {
      expect(text).toContain(r.title);
      for (const c of r.calls) expect(OPS_TOOLS, c.tool).toContain(c.tool);
    }
    expect(text).not.toMatch(/apply_cadscript|CadScript/);
  });

  for (const recipe of OPS_RECIPES) {
    it_(`recipe "${recipe.id}" builds call by call`, async () => {
      const host = await MemoryOpsHost.open({ engine: await forgeEngine(), document: blankDocument(recipe.id), origin: "agent" });
      const registry = opsRegistry();
      for (const [i, c] of recipe.calls.entries()) {
        const out = await registry.execute({ name: c.tool, input: c.input }, { ops: host });
        expect(out.isError, `${recipe.id} call ${i + 1} ${c.tool}: ${out.text}`).toBeFalsy();
      }
      const report = await host.report();
      const failing = report.features.filter((f) => f.status !== "ok").map((f) => `${f.feature}: ${f.error?.code}`);
      expect(failing).toEqual([]);
      const bodies = (report.parts ?? []).flatMap((p) => p.bodies);
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.every((b) => b.valid)).toBe(true);
    });
  }
});

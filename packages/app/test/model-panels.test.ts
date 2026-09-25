/**
 * The model panels' pure parts: the browser tree from the timeline and the body names, the
 * problem list's warnings, notes and parameter failures, the filament palette, and the undo scope
 * that sends the one Undo to sketch mode while it is open.
 */
import { describe, expect, it } from "vitest";
import type { EvalReport } from "@aicad/ir-types";
import { compileAndCheck } from "../src/cadscript/inline-service";
import { collectProblems } from "../src/doc/problems";
import { buildTimeline } from "../src/doc/timeline";
import { undoScopes } from "../src/doc/undo-scope";
import { buildBrowserTree, parseBodyName } from "../src/ui/model/browser-model";
import { filamentOf, PLA_BASIC } from "../src/ui/model/filaments";
import { BOX } from "./helpers";

const report = (features: EvalReport["features"], extra: Record<string, unknown> = {}): EvalReport => ({ schema: "aicad.metrics/0", engine: "forge", document: "box", status: "ok", features, ...extra }) as EvalReport;

describe("problems", () => {
  const out = compileAndCheck(BOX);

  it("list warnings worth a look and notes, but not an under-constrained sketch", () => {
    const r = report([
      { part: "plate", feature: "outline", type: "sketch", status: "ok", warnings: [{ code: "SKETCH_UNDER_CONSTRAINED", severity: "warning", message: "4 DOF" }] } as never,
      {
        part: "plate",
        feature: "plate",
        type: "extrude",
        status: "ok",
        warnings: [
          { code: "PATTERN_OVERLAP", severity: "warning", message: "instances overlap" },
          { code: "FORGE_BOOLEAN_NO_CHANGE", severity: "info", message: "the join left 1 of 2 bodies as they were" },
        ],
      } as never,
    ]);
    const p = collectProblems({ compile: out, model: out, report: r, engineError: null });
    expect(p.map((x) => [x.severity, x.code, x.featureName])).toEqual([
      ["warning", "PATTERN_OVERLAP", "plate"],
      ["info", "FORGE_BOOLEAN_NO_CHANGE", "plate"],
    ]);
    // A note never gets the "engine-internal failure" hint.
    expect(p[1]!.hint).toBeUndefined();
    // The timeline marks the warning, not the note.
    const t = buildTimeline({ compile: out, model: out, report: r }, p);
    expect(t.parts[0]!.features.map((f) => f.status)).toEqual(["ok", "warning"]);
  });

  it("list a parameter that does not evaluate, with its name", () => {
    const r = report([], { params: [{ name: "wall", scope: "doc", unit: "mm", error: { code: "EXPR_UNKNOWN_NAME", message: "unknown name thick" } }] });
    const p = collectProblems({ compile: out, model: out, report: r, engineError: null });
    expect(p).toEqual([expect.objectContaining({ severity: "error", code: "EXPR_UNKNOWN_NAME", param: "wall", message: "parameter wall: unknown name thick" })]);
  });
});

describe("browser tree", () => {
  it("parses body names: part, origin feature, piece", () => {
    expect(parseBodyName("part/extrude1")).toEqual({ part: "part", feature: "extrude1", piece: null });
    expect(parseBodyName("p1/pucks#1")).toEqual({ part: "p1", feature: "pucks", piece: 1 });
  });

  it("puts bodies under their part with the feature that made them; sketches and datums apart", () => {
    const out = compileAndCheck(BOX);
    const t = buildTimeline({ compile: out, model: out, report: null }, []);
    const tree = buildBrowserTree(t, ["plate/plate#0", "plate/plate#1", "plate/ghost"]);
    const part = tree.parts[0]!;
    expect(part.bodies.map((b) => [b.name, b.label, b.feature?.name ?? null])).toEqual([
      ["plate/plate#0", "plate (1)", "plate"],
      ["plate/plate#1", "plate (2)", "plate"],
      ["plate/ghost", "ghost", null],
    ]);
    expect(part.sketches.map((f) => f.name)).toEqual(["outline"]);
    expect(part.construction).toEqual([]);
    expect(tree.bodyCount).toBe(3);
  });
});

describe("filament colours", () => {
  it("are Bambu Lab PLA Basic's 30 published colours, unique, as lower-case #rrggbb", () => {
    expect(PLA_BASIC).toHaveLength(30);
    expect(new Set(PLA_BASIC.map((f) => f.hex)).size).toBe(30);
    for (const f of PLA_BASIC) expect(f.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(filamentOf("#00AE42")?.name).toBe("Bambu Green");
    expect(filamentOf("#123456")).toBeNull();
  });
});

describe("undo scope", () => {
  it("is the open session's until it closes, and only its own id closes it", () => {
    const calls: string[] = [];
    undoScopes.set({ id: "sketch", label: "sketch s", canUndo: true, canRedo: false, undo: () => calls.push("undo"), redo: () => calls.push("redo") });
    expect(undoScopes.active?.id).toBe("sketch");
    undoScopes.clear("other");
    expect(undoScopes.active?.id).toBe("sketch");
    undoScopes.active?.undo();
    undoScopes.clear("sketch");
    expect(undoScopes.active).toBeNull();
    expect(calls).toEqual(["undo"]);
  });
});

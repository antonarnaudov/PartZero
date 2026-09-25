/**
 * The IR v1 command layer (SPEC-v1 §0.6, §5.9, §9.2; IR-V1 plan W9 / interface I7) end to end:
 * the DocStore ops on the real Forge engine (`@aicad/forge-web` WASM, loaded from
 * `packages/forge-web/pkg`), each with an apply → undo → identical-IR test and a redo test (the
 * upgrade on a stub engine: the contract defines no v2 yet), the op-level idempotence of
 * writeBackSolution (the [W0-31] welding case included) and captureRef, one-step undo of a
 * transaction that contains them, the canonical document of record, serialised transaction ops,
 * the repair ops offered, and the commands the palette and the agent call.
 */
import type { metricsV1 } from "@aicad/ir-types";
import { beforeAll, describe, expect, it } from "vitest";
import constrainedPlate from "../../../corpus/v1/programs/constrained_plate.json?raw";
import paramsPlate from "../../../corpus/v1/programs/params_plate.json?raw";
import plateFeatures from "../../../corpus/v1/programs/plate_features.json?raw";
import {
  CommandEngineError,
  forgeWebCommandEngine,
  missingCommandMembers,
  type ForgeWebCommandModule,
  type IrCommandEngine,
  type WriteBackResult,
} from "../src/doc/v1/command-engine";
import { IrDocStore, type IrTransaction } from "../src/doc/v1/ir-doc-store";
import { applyOp, IrOpSchema, refEntries, repairOps, upgradeConfirmation, type IrOp } from "../src/doc/v1/ops";
import { makeHarness } from "./helpers";

// Node's fs through a runtime specifier: this package type-checks without Node's types.
const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as { existsSync(p: URL): boolean; readFileSync(p: URL): Uint8Array };
const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
const hasWasm = fs.existsSync(wasmUrl);
// `packages/forge-web/pkg` is gitignored: CI builds it before testing (`pnpm -r build`). A CI run
// without it must fail, not report green with every engine test skipped; a local run says so.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
if (!hasWasm) {
  const why = "packages/forge-web/pkg is not built (run pnpm --filter @aicad/forge-web build:wasm)";
  if (env["CI"]) throw new Error(`ir-v1-ops: ${why}; the IR v1 command-layer tests need the Forge WASM engine on CI`);
  console.warn(`ir-v1-ops: ${why}: every Forge-engine test of this file is SKIPPED (only the stub-engine tests run)`);
}

let engine: IrCommandEngine;
/** The forge-web module (its argument checks are tested directly). */
let web: ForgeWebCommandModule;
/** The raw WASM exports under forge-web (their own argument checks). */
let raw: Record<string, (...args: unknown[]) => unknown>;

beforeAll(async () => {
  if (!hasWasm) return;
  // The forge-web sources (not the built dist), by path: kept out of this package's type program.
  const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
  const forgeWeb = (await import(/* @vite-ignore */ entry)) as ForgeWebCommandModule & {
    init(input: unknown): Promise<void>;
  };
  await forgeWeb.init(fs.readFileSync(wasmUrl));
  const missing = missingCommandMembers(forgeWeb);
  if (missing.length) throw new Error(`packages/forge-web/pkg is stale (missing ${missing.join(", ")}): run pnpm --filter @aicad/forge-web build:wasm`);
  engine = forgeWebCommandEngine(forgeWeb);
  web = forgeWeb;
  // The same glue module forge-web imports (initialised by its init()).
  const glue = new URL("../../forge-web/pkg/forge_wasm.js", import.meta.url).pathname;
  raw = (await import(/* @vite-ignore */ glue)) as typeof raw;
}, 60_000);

const PROGRAMS: Record<string, string> = { "constrained_plate.json": constrainedPlate, "params_plate.json": paramsPlate };
const program = (name: string): string => PROGRAMS[name]!;

const line = (id: string, start: [number, number], end: [number, number]) => ({ kind: "line", id, start, end });
const tag = (id: string, kind: string, q: unknown, card: unknown = "one") => ({ type: "tag", id, name: id, target: { kind, q, card } });

/** A plate (sketch s1 → extrude e1) with tags on a face, a junction edge, a body and a broad edge set. */
function plate(extra: unknown[] = []): string {
  return JSON.stringify({
    schema: "aicad.ir/1",
    meta: { name: "plate" },
    params: [{ name: "t", unit: "mm", value: 6, min: 1 }],
    parts: [
      {
        id: "p1",
        name: "part",
        features: [
          {
            type: "sketch",
            id: "s1",
            name: "base",
            plane: "XY",
            curves: [line("bottom", [-20, -10], [20, -10]), line("right", [20, -10], [20, 10]), line("top", [20, 10], [-20, 10]), line("left", [-20, 10], [-20, -10])],
          },
          { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: "t" },
          tag("t_side", "face", { op: "side", feature: "e1", curve: "top" }),
          tag("t_edge", "edge", { op: "edge_at", feature: "e1", curve: "right", end: "end" }),
          tag("t_body", "body", { op: "body", feature: "e1", member: "top" }),
          tag("t_vertical", "edge", { op: "filter", where: { parallel: "Z" }, of: { op: "edges", of: { op: "sides", feature: "e1" } } }, "some"),
          ...extra,
        ],
      },
    ],
  });
}

/** constrained_plate with its corner bottom.end / right.start opened and closed by a `coincident`: the solve welds it. */
function unweldedCorner(): string {
  const doc = JSON.parse(program("constrained_plate.json")) as {
    parts: Array<{ features: Array<{ curves?: Array<{ start?: number[] }>; constraints?: unknown[] }> }>;
  };
  const sketch = doc.parts[0]!.features[0]!;
  sketch.curves![1]!.start = [40.3, -25.2];
  sketch.constraints!.push({ type: "coincident", id: "cc", a: "bottom.end", b: "right.start" });
  return JSON.stringify(doc);
}

const rectLines = (ids: [string, string, string, string], x0: number, y0: number, x1: number, y1: number) => [
  line(ids[0], [x0, y0], [x1, y0]),
  line(ids[1], [x1, y0], [x1, y1]),
  line(ids[2], [x1, y1], [x0, y1]),
  line(ids[3], [x0, y1], [x0, y0]),
];

/** Two plates (tops t1, t2) and a far one, extruded; a tag on both tops. */
function twoTops(): string {
  return JSON.stringify({
    schema: "aicad.ir/1",
    meta: { name: "tops" },
    parts: [
      {
        id: "p1",
        name: "part",
        features: [
          {
            type: "sketch",
            id: "s1",
            name: "base",
            plane: "XY",
            curves: [
              ...rectLines(["a_b", "a_r", "t1", "a_l"], 0, 0, 10, 10),
              ...rectLines(["b_b", "b_r", "t2", "b_l"], 20, 0, 30, 10),
              ...rectLines(["c_b", "c_r", "c_t", "c_l"], 990, 990, 1000, 1000),
            ],
          },
          { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: 5 },
          tag("t_tops", "face", { op: "union", of: [{ op: "side", feature: "e1", curve: "t1" }, { op: "side", feature: "e1", curve: "t2" }] }, "some"),
        ],
      },
    ],
  });
}

/** The diff the upgrade stub reports. */
const STUB_DIFF = [{ feature_id: "e1", before: { v: 1 }, after: { v: 2 } }];

/**
 * An engine whose `upgradeFeature` changes the document (sets `v`): the store's undo does not
 * depend on the op, so this checks apply → undo → redo of an upgrade before the contract defines
 * a v2. Everything else is the identity.
 */
function upgradeStub(): IrCommandEngine {
  const unsupported = () => Promise.reject(new CommandEngineError("STUB", "not stubbed"));
  return {
    migrate: (ir) => Promise.resolve({ document: ir, renames: [] }),
    canonicalize: (ir) => Promise.resolve({ document: ir, renames: [] }),
    params: () => Promise.resolve([]),
    report: unsupported,
    writeBack: (ir) => Promise.resolve({ document: ir, changed: false, written: [], skipped: [], passes: 1 }),
    setParam: unsupported,
    renameFeature: unsupported,
    upgradeFeature: (ir, featureId, to) => {
      const doc = JSON.parse(ir) as { parts: Array<{ features: Array<{ id: string; v?: number }> }> };
      const f = doc.parts[0]!.features.find((x) => x.id === featureId)!;
      const from = f.v ?? 1;
      f.v = to ?? 2;
      const result = { feature: featureId, type: "extrude", from, to: f.v, diff: STUB_DIFF };
      return Promise.resolve({ document: JSON.stringify(doc), changed: f.v !== from, result });
    },
    captureRef: unsupported,
    acceptRefProposal: unsupported,
    acceptRefCandidate: unsupported,
    renameCurve: unsupported,
  };
}

/** A plate whose tag is ambiguous (card one on the four edges of a face): REF_AMBIGUOUS with candidates. */
function ambiguous(): string {
  return plate([tag("t_amb", "edge", { op: "edges", of: { op: "side", feature: "e1", curve: "top" } })]);
}

/** A triangle whose `a.end` / `b.start` gap is driven to 5e-7 mm: once written back, the weld makes `g` a conflict ([W0-31]). */
function weldConflict(): string {
  return JSON.stringify({
    schema: "aicad.ir/1",
    meta: { name: "weld" },
    parts: [
      {
        id: "p1",
        name: "part",
        features: [
          {
            type: "sketch",
            id: "s1",
            name: "tri",
            plane: "XY",
            curves: [line("a", [0, 0], [10, 0]), line("b", [10.001, 0.0007], [5, 8]), line("c", [5, 8], [0, 0])],
            constraints: [
              { type: "distance", id: "g", a: "a.end", b: "b.start", value: 5e-7 },
              { type: "horizontal", id: "h", line: "a" },
              { type: "distance", id: "L", a: "a.start", b: "a.end", value: 10 },
              { type: "fix", id: "f", entity: "a.start" },
            ],
          },
          { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: 3 },
        ],
      },
    ],
  });
}

/**
 * An engine over plain text documents (`DOC;` + `name=value;` per setParam) for the store's own
 * rules: `setParam` of `bad` is refused; `writeBack` is the identity unless given.
 */
function textEngine(writeBack?: (ir: string) => Promise<WriteBackResult>): IrCommandEngine {
  const unsupported = () => Promise.reject(new CommandEngineError("STUB", "not stubbed"));
  return {
    migrate: (ir) => Promise.resolve({ document: ir, renames: [] }),
    canonicalize: (ir) => Promise.resolve({ document: ir, renames: [] }),
    params: () => Promise.resolve([]),
    report: unsupported,
    writeBack: writeBack ?? ((ir) => Promise.resolve({ document: ir, changed: false, written: [], skipped: [], passes: 1 })),
    setParam: (ir, name, value) =>
      name === "bad"
        ? Promise.reject(new CommandEngineError("COMMAND_UNKNOWN_PARAM", "no parameter bad", [], { name }))
        : Promise.resolve({ document: `${ir}${name}=${String(value)};`, changed: true, result: { param: name, previous: 0, value, params: [] } }),
    renameFeature: unsupported,
    upgradeFeature: unsupported,
    captureRef: unsupported,
    acceptRefProposal: unsupported,
    acceptRefCandidate: unsupported,
    renameCurve: unsupported,
  };
}

async function store(text: string, autoWriteBack = true): Promise<IrDocStore> {
  const s = new IrDocStore({ engine: () => engine, autoWriteBack });
  await s.load(text);
  return s;
}

async function captureAll(s: IrDocStore): Promise<void> {
  const report = await s.report();
  await s.transaction("capture all", async (tx) => {
    for (const r of refEntries(report)) await tx.apply({ op: "captureRef", feature: r.featureId, field: r.field });
  });
}

function ref(report: metricsV1.EvalReport, feature: string, field = "/target"): metricsV1.RefReport {
  const e = refEntries(report, feature).find((r) => r.field === field);
  if (!e) throw new Error(`no reference ${feature}${field}`);
  return e.entry;
}

/** apply → undo → identical document; redo → identical to after; undo again → identical. */
async function checkUndoRedo(s: IrDocStore, op: IrOp): Promise<string> {
  const before = s.document;
  const t = await s.apply(op);
  expect(t.changed).toBe(true);
  const after = s.document;
  expect(after).not.toBe(before);
  expect(s.undo()).toBe(true);
  expect(s.document).toBe(before);
  expect(s.redo()).toBe(true);
  expect(s.document).toBe(after);
  expect(s.undo()).toBe(true);
  expect(s.document).toBe(before);
  expect(s.redo()).toBe(true);
  return after;
}

describe.skipIf(!hasWasm)("IR v1 command layer on Forge (forge-web WASM)", () => {
  describe("every op: apply → undo → identical IR, redo", () => {
    it("setParam, with its semantic inverse", async () => {
      const s = await store(program("params_plate.json"));
      const before = s.document;
      await checkUndoRedo(s, { op: "setParam", name: "thick", value: "width/10" });
      expect(s.getState().params?.find((p) => p.name === "thick")?.value).toBe(8);
      const t = s.getState().last!;
      expect(t.ops[0]!.inverse).toEqual({ op: "setParam", name: "thick", value: 8 });
      // The semantic inverse restores the same bytes as undo.
      await s.apply(t.ops[0]!.inverse!);
      expect(s.document).toBe(before);
    });

    it("writeBackSolution, to its fixed point when the solve welds ends ([W0-31])", async () => {
      const s = await store(unweldedCorner(), false);
      const before = s.document;
      const after = await checkUndoRedo(s, { op: "writeBackSolution" });
      const t = s.getState().last!;
      expect((t.ops[0]!.result as { passes: number }).passes).toBe(3);
      // write-back ∘ write-back = write-back, and nothing is recorded.
      const again = await s.apply({ op: "writeBackSolution" });
      expect(again.changed).toBe(false);
      expect(s.document).toBe(after);
      // One undo step restores the document as loaded.
      expect(s.undo()).toBe(true);
      expect(s.document).toBe(before);
    });

    it("writeBackSolution", async () => {
      // A stored guess the solver moves: the write-back stores the solution.
      // (Both ends of the corner move, so they stay welded, SPEC-v1 §4.3.)
      const doc = JSON.parse(program("constrained_plate.json")) as {
        parts: Array<{ features: Array<{ curves?: Array<{ start?: number[]; end?: number[] }> }> }>;
      };
      const curves = doc.parts[0]!.features[0]!.curves!;
      curves[0]!.end = [40.5, -25];
      curves[1]!.start = [40.5, -25];
      const s = await store(JSON.stringify(doc), false);
      await checkUndoRedo(s, { op: "writeBackSolution" });
      // Idempotent at the op level: a second write-back changes nothing and records nothing.
      const undoBefore = s.getState().history.undoLabel;
      const again = await s.apply({ op: "writeBackSolution" });
      expect(again.changed).toBe(false);
      expect(s.getState().history.undoLabel).toBe(undoBefore);
    });

    it("captureRef, idempotent", async () => {
      const s = await store(plate());
      const after = await checkUndoRedo(s, { op: "captureRef", feature: "t_edge", field: "/target" });
      const r = ref(await s.report(), "t_edge");
      expect(r.status).toBe("exact");
      const again = await s.apply({ op: "captureRef", feature: "t_edge", field: "/target" });
      expect(again.changed).toBe(false);
      expect(s.document).toBe(after);
    });

    it("acceptRefProposal (a broad set that changed)", async () => {
      const s = await store(plate());
      await captureAll(s);
      // The sketch gains a side: t_vertical's broad set changed (REF_SET_CHANGED, with a proposal).
      const doc = JSON.parse(s.document) as { parts: Array<{ features: Array<Record<string, unknown>> }> };
      doc.parts[0]!.features[0]!["curves"] = [
        line("bottom", [-20, -10], [20, -10]),
        line("right", [20, -10], [20, 10]),
        line("top", [20, 10], [0, 10]),
        line("notch", [0, 10], [-20, 5]),
        line("left", [-20, 5], [-20, -10]),
      ];
      await s.load(JSON.stringify(doc));
      const r = ref(await s.report(), "t_vertical");
      expect(r.status).toBe("accepted");
      expect(r.proposal).toBeDefined();
      const loc = refEntries(await s.report(), "t_vertical")[0]!;
      expect(repairOps(loc)[0]).toEqual({ op: "acceptRefProposal", feature: "t_vertical", field: "/target" });
      await checkUndoRedo(s, { op: "acceptRefProposal", feature: "t_vertical", field: "/target" });
      const r2 = ref(await s.report(), "t_vertical");
      expect(r2.status).toBe("exact");
      expect(r2.members).toHaveLength(5);
    });

    it("acceptRefCandidate (an ambiguous reference)", async () => {
      const s = await store(ambiguous());
      const r = ref(await s.report(), "t_amb");
      expect(r.code).toBe("REF_AMBIGUOUS");
      const c = r.unresolved![0]!.candidates[1]!;
      await checkUndoRedo(s, { op: "acceptRefCandidate", feature: "t_amb", field: "/target", member: "", candidate: c.key });
      const r2 = ref(await s.report(), "t_amb");
      expect(r2.status).toBe("exact");
      expect(r2.members.map((m) => [m.key, m.probe])).toEqual([[c.key, c.probe]]);
    });

    it("renameCurve, with its semantic inverse", async () => {
      const s = await store(plate());
      await captureAll(s);
      const before = s.document;
      await checkUndoRedo(s, { op: "renameCurve", sketch: "s1", old: "right", new: "a_right" });
      const report = await s.report();
      for (const l of refEntries(report)) expect(l.entry.status, `${l.featureId}${l.field}`).toBe("exact");
      expect(s.document).not.toContain('"right"');
      await s.apply(s.getState().last!.ops[0]!.inverse!);
      expect(s.document).toBe(before);
    });

    it("renameFeature, with its semantic inverse", async () => {
      const s = await store(plate());
      const before = s.document;
      await checkUndoRedo(s, { op: "renameFeature", feature: "e1", name: "plate" });
      expect(s.getState().last!.ops[0]!.inverse).toEqual({ op: "renameFeature", feature: "e1", name: "slab" });
      await s.apply(s.getState().last!.ops[0]!.inverse!);
      expect(s.document).toBe(before);
    });

    it("upgradeFeature (a changing upgrade, on a stub engine: the contract defines no v2 yet)", async () => {
      const s = new IrDocStore({ engine: () => upgradeStub() });
      await s.load(plate());
      const op: IrOp = { op: "upgradeFeature", feature: "e1", to: 2 };
      // §9.2: the diff is shown before the upgrade is applied — without its token it is refused…
      const refused = (await s.apply(op).catch((x: unknown) => x)) as CommandEngineError;
      expect(refused.code).toBe("COMMAND_UPGRADE_UNCONFIRMED");
      expect(refused.details["diff"]).toEqual(STUB_DIFF);
      expect(s.getState().history.canUndo).toBe(false);
      // …the preview returns the diff and its token, which applies it.
      const preview = await s.preview(op);
      const confirm = (preview.result as { confirm: string }).confirm;
      expect(confirm).toBe(refused.details["confirm"]);
      expect(confirm).toBe(upgradeConfirmation({ feature: "e1", type: "extrude", from: 1, to: 2, diff: STUB_DIFF }));
      expect(preview.changed).toBe(true);
      expect(s.getState().history.canUndo).toBe(false);
      const after = await checkUndoRedo(s, { ...op, confirm });
      expect(JSON.parse(after).parts[0].features[1].v).toBe(2);
      // A token of another diff is refused.
      await s.load(plate());
      const other = (await s.apply({ ...op, confirm: `${confirm}0` }).catch((x: unknown) => x)) as CommandEngineError;
      expect(other.code).toBe("COMMAND_UPGRADE_UNCONFIRMED");
      expect(other.details["given"]).toBe(`${confirm}0`);
    });

    it("upgradeFeature: the current version is a no-op; an undefined one is refused with its code", async () => {
      const s = await store(plate());
      const t = await s.apply({ op: "upgradeFeature", feature: "e1" });
      expect(t.changed).toBe(false);
      expect(t.ops[0]!.result).toMatchObject({ from: 1, to: 1, diff: [] });
      expect(s.getState().history.canUndo).toBe(false);
      const e = await s.apply({ op: "upgradeFeature", feature: "e1", to: 2 }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CommandEngineError);
      expect((e as CommandEngineError).code).toBe("UNSUPPORTED_FEATURE_VERSION");
      expect((e as CommandEngineError).errors[0]?.path).toBe("/parts/0/features/1/v");
    });
  });

  describe("the document of record", () => {
    it("is canonical: load stores canonical expressions and the setParam inverse is byte-exact", async () => {
      const doc = JSON.parse(program("params_plate.json")) as { params: Array<{ value: unknown }> };
      doc.params[1]!.value = "width/10";
      const s = await store(JSON.stringify(doc));
      expect(s.document).toContain('"width / 10"');
      expect(s.document).not.toContain("width/10");
      const loaded = s.document;
      await s.apply({ op: "setParam", name: "depth", value: 7 });
      const inverse = s.getState().last!.ops[0]!.inverse!;
      expect(inverse).toEqual({ op: "setParam", name: "depth", value: "width / 10" });
      await s.apply(inverse);
      expect(s.document).toBe(loaded);
    });

    it("takes pure IR edits of documents Forge does not evaluate (the optional draft)", async () => {
      const draft = { type: "draft", id: "d1", name: "taper", faces: { kind: "face", q: { op: "sides", feature: "e1" } }, neutral: "XY", angle: 2 };
      const s = await store(plate([draft]));
      const before = s.document;
      const t = await s.apply({ op: "renameFeature", feature: "d1", name: "taper2" });
      expect(t.changed).toBe(true);
      expect(t.ops.map((o) => o.op.op)).toEqual(["renameFeature"]);
      expect(t.writeBackSkipped?.code).toBe("UNSUPPORTED_FEATURE");
      const p = await s.apply({ op: "setParam", name: "t", value: "4*2" });
      expect(p.ops[0]!.result).toMatchObject({ value: "4 * 2" });
      expect(s.undo() && s.undo()).toBe(true);
      expect(s.document).toBe(before);
      // The evaluated ops are refused with the engine's capability check.
      const e = (await s.apply({ op: "captureRef", feature: "t_side", field: "/target" }).catch((x: unknown) => x)) as CommandEngineError;
      expect(e.code).toBe("UNSUPPORTED_FEATURE");
    });

    it("refuses a document whose canonical form would be rejected ([W0-20])", async () => {
      const doc = JSON.parse(program("params_plate.json")) as { params: Array<{ value: unknown }> };
      doc.params[2]!.value = "1"; // thick has min 2: the literal 1 is rejected at load
      const s = new IrDocStore({ engine: () => engine });
      const e = (await s.load(JSON.stringify(doc)).catch((x: unknown) => x)) as CommandEngineError;
      expect(e.code).toBe("PARAM_OUT_OF_RANGE");
      expect(e.errors[0]?.path).toBe("/params/2/value");
      expect(s.getState().document).toBeNull();
    });
  });

  describe("transactions", () => {
    it("after the fixed point, a later unrelated op records no geometry change", async () => {
      const s = await store(unweldedCorner());
      // The first edit's automatic write-back runs to the fixed point, inside that edit.
      const first = await s.apply({ op: "renameFeature", feature: "e1", name: "slab_a" });
      expect(first.ops.map((o) => o.op.op)).toEqual(["renameFeature", "writeBackSolution"]);
      expect((first.ops[1]!.result as { passes: number }).passes).toBe(3);
      const before = s.document;
      const second = await s.apply({ op: "renameFeature", feature: "e1", name: "slab_b" });
      expect(second.ops.map((o) => o.op.op)).toEqual(["renameFeature"]);
      expect(s.document).toBe(before.replace('"name": "slab_a"', '"name": "slab_b"'));
      expect(s.undo()).toBe(true);
      expect(s.document).toBe(before);
    });

    it("applies concurrent tx.apply calls one at a time, in call order, and closes the handle", async () => {
      const s = await store(program("params_plate.json"));
      const leaked: { tx?: IrTransaction } = {};
      const t = await s.transaction("both", async (tx) => {
        leaked.tx = tx;
        await Promise.all([
          tx.apply({ op: "setParam", name: "width", value: 90 }),
          tx.apply({ op: "setParam", name: "depth", value: 40 }),
        ]);
        // Started without awaiting: still part of the transaction.
        void tx.apply({ op: "setParam", name: "thick", value: 9 });
      });
      expect(t.ops.map((o) => (o.op as { name?: string }).name)).toEqual(["width", "depth", "thick"]);
      const values = Object.fromEntries((s.getState().params ?? []).map((p) => [p.name, p.value]));
      expect(values).toMatchObject({ width: 90, depth: 40, thick: 9 });
      expect(s.getState().history.undoLabel).toBe("both");
      // The handle is closed once the transaction has finished.
      const e = (await leaked.tx!.apply({ op: "setParam", name: "width", value: 1 }).catch((x: unknown) => x)) as CommandEngineError;
      expect(e.code).toBe("IR_TRANSACTION_CLOSED");
      expect(Object.fromEntries((s.getState().params ?? []).map((p) => [p.name, p.value]))["width"]).toBe(90);
    });

    it("an edit, its write-back and a capture undo as one step", async () => {
      const text = JSON.parse(program("constrained_plate.json")) as { parts: Array<{ features: unknown[] }> };
      text.parts[0]!.features.push(tag("t", "face", { op: "side", feature: "e1", curve: "top" }));
      const s = await store(JSON.stringify(text));
      const before = s.document;
      const t = await s.transaction("Widen and capture", async (tx) => {
        await tx.apply({ op: "setParam", name: "width", value: 90 });
        await tx.apply({ op: "captureRef", feature: "t", field: "/target" });
      });
      // The automatic write-back (§0.6) ran inside the transaction, before the capture (which then
      // describes the stored geometry): the solution moved to 90 mm.
      expect(t.ops.map((o) => o.op.op)).toEqual(["setParam", "writeBackSolution", "captureRef"]);
      expect(s.document).toContain("45.0");
      expect(s.getState().history.undoLabel).toBe("Widen and capture");
      expect(s.undo()).toBe(true);
      expect(s.document).toBe(before);
      expect(s.getState().history.canUndo).toBe(false);
      expect(s.redo()).toBe(true);
      expect(s.document).toBe(t.document);
      // Idempotent: writing back and capturing again changes nothing.
      const again = await s.transaction("again", async (tx) => {
        await tx.apply({ op: "writeBackSolution" });
        await tx.apply({ op: "captureRef", feature: "t", field: "/target" });
      });
      expect(again.changed).toBe(false);
    });

    it("is atomic: a refused op leaves the document and the history unchanged", async () => {
      const s = await store(ambiguous());
      const before = s.document;
      const e = await s
        .transaction("mixed", async (tx) => {
          await tx.apply({ op: "setParam", name: "t", value: 9 });
          await tx.apply({ op: "captureRef", feature: "t_amb", field: "/target" });
        })
        .catch((x: unknown) => x);
      expect((e as CommandEngineError).code).toBe("COMMAND_REF_FAILED");
      expect((e as CommandEngineError).details["code"]).toBe("REF_AMBIGUOUS");
      expect(s.document).toBe(before);
      expect(s.getState().history.canUndo).toBe(false);
    });

    it("captureRef is idempotent through the store when the write-back welds ends ([W0-31])", async () => {
      const doc = JSON.parse(unweldedCorner()) as { parts: Array<{ features: unknown[] }> };
      doc.parts[0]!.features.push(tag("tv", "vertex", { op: "vertices", of: { op: "side", feature: "e1", curve: "right" } }, "some"));
      const s = await store(JSON.stringify(doc));
      const loaded = s.document;
      // The capture is taken on the written-back geometry: the write-back runs first.
      const first = await s.apply({ op: "captureRef", feature: "tv", field: "/target" });
      expect(first.ops.map((o) => o.op.op)).toEqual(["writeBackSolution", "captureRef"]);
      expect((first.ops[0]!.result as { passes: number }).passes).toBe(3);
      const again = await s.apply({ op: "captureRef", feature: "tv", field: "/target" });
      expect(again.changed).toBe(false);
      expect(again.ops.map((o) => [o.op.op, o.changed])).toEqual([["captureRef", false]]);
      expect(s.getState().history.undoLabel).toBe("Capture reference tv/target");
      expect(s.undo()).toBe(true);
      expect(s.document).toBe(loaded);
    });

    it("never writes back a solution that would fail its sketch: it is withheld and reported", async () => {
      const s = await store(weldConflict());
      const t = await s.apply({ op: "renameFeature", feature: "e1", name: "slab2" });
      expect(t.ops.map((o) => o.op.op)).toEqual(["renameFeature"]);
      expect(t.writeBackWithheld).toEqual([{ sketch: "s1", code: "SKETCH_CONSTRAINT_CONFLICT" }]);
      // The model still evaluates: nothing failed.
      const report = await s.report();
      expect(report.features.filter((f) => f.status === "error").map((f) => f.feature_id)).toEqual([]);
      // The explicit op says the same, and changes nothing.
      const wb = await s.apply({ op: "writeBackSolution" });
      expect(wb.changed).toBe(false);
      expect(wb.ops[0]!.result).toMatchObject({ skipped: [{ sketch: "s1", reason: "would-fail", code: "SKETCH_CONSTRAINT_CONFLICT" }] });
    });

    it("a captureRef refusal carries the reference's own entry, which acceptRefCandidate takes as given", async () => {
      const s = await store(plate());
      await captureAll(s);
      // A through-cut splits the plate in two, and the captured `top` face with it (REF_SPLIT).
      const doc = JSON.parse(s.document) as { parts: Array<{ features: unknown[] }> };
      doc.parts[0]!.features.splice(
        2,
        0,
        { type: "sketch", id: "s2", name: "cutter", plane: "XY", curves: rectLines(["cb", "cr", "ct", "cl"], -2, -15, 2, 15) },
        { type: "extrude", id: "e2", name: "cut", sketch: "s2", distance: 10, op: "cut", targets: { kind: "body", q: { op: "bodies" } } },
      );
      await s.load(JSON.stringify(doc));
      const e = (await s.apply({ op: "captureRef", feature: "t_side", field: "/target" }).catch((x: unknown) => x)) as CommandEngineError;
      expect(e.code).toBe("COMMAND_REF_FAILED");
      expect(e.details["code"]).toBe("REF_SPLIT");
      const u = (e.details["unresolved"] as metricsV1.Unresolved[])[0]!;
      expect(u.key).toBe("e1/side:top");
      expect(u.candidates.length).toBeGreaterThanOrEqual(2);
      const t = await s.apply({ op: "acceptRefCandidate", feature: "t_side", field: "/target", member: u.key, candidate: u.candidates[1]!.key, candidateIndex: 1 });
      expect(t.changed).toBe(true);
      const r = ref(await s.report(), "t_side");
      expect(r.status).toBe("exact");
      expect(r.members.map((m) => m.probe)).toEqual([u.candidates[1]!.probe]);
    });

    it("a repair names the entity the caller read: a stale candidateIndex after the write-back is refused, its probe applies", async () => {
      // constrained_plate with a tag on its `top` side, captured; a through-cut then splits it
      // (REF_SPLIT: the pieces share the key), and the sketch's stored corner is moved off the
      // solution, so the store's write-back before the repair changes the document.
      const base = JSON.parse(program("constrained_plate.json")) as { parts: Array<{ features: unknown[] }> };
      base.parts[0]!.features.push(tag("t_side", "face", { op: "side", feature: "e1", curve: "top" }));
      const s = await store(JSON.stringify(base));
      await captureAll(s);
      const doc = JSON.parse(s.document) as { parts: Array<{ features: unknown[] }> };
      const curves = (doc.parts[0]!.features[0] as { curves: Array<{ start: number[]; end: number[] }> }).curves;
      curves[0]!.end = [40.5, -25];
      curves[1]!.start = [40.5, -25];
      doc.parts[0]!.features.splice(
        2,
        0,
        { type: "sketch", id: "s2", name: "cutter", plane: "XY", curves: rectLines(["cb", "cr", "ct", "cl"], -2, -30, 2, 30) },
        { type: "extrude", id: "e2", name: "cut", sketch: "s2", distance: 10, op: "cut", targets: { kind: "body", q: { op: "bodies" } } },
      );
      await s.load(JSON.stringify(doc));
      const loaded = s.document;
      const loc = refEntries(await s.report(), "t_side")[0]!;
      expect(loc.entry.code).toBe("REF_SPLIT");
      const op = repairOps(loc).find((o) => o.op === "acceptRefCandidate" && o.candidate === "e1/side:top" && (o.candidateIndex ?? 0) > 0);
      if (op?.op !== "acceptRefCandidate") throw new Error("no second piece offered");
      expect(op.probe).toEqual(loc.entry.unresolved![0]!.candidates[op.candidateIndex!]!.probe);
      // Without the probe, the index was read from the report of the document before the write-back.
      const { probe, ...withoutProbe } = op;
      expect(probe).toBeDefined();
      const stale = (await s.apply(withoutProbe).catch((x: unknown) => x)) as CommandEngineError;
      expect(stale.code).toBe("COMMAND_CANDIDATE_CHANGED");
      expect(stale.details).toMatchObject({ reason: "written-back", index: op.candidateIndex });
      expect(s.document).toBe(loaded);
      expect(s.getState().history.canUndo).toBe(false);
      // With it, the op applies, after the write-back, to the entity the caller saw.
      const t = await s.apply(op);
      expect(t.ops.map((o) => o.op.op)).toEqual(["writeBackSolution", "acceptRefCandidate"]);
      const r = ref(await s.report(), "t_side");
      expect(r.status).toBe("exact");
      expect(r.members[0]!.probe).toEqual(op.probe);
      // A probe no candidate is at any more is refused by the engine.
      expect(s.undo()).toBe(true);
      const p = op.probe!;
      const far = { ...p, point: [p.point[0], p.point[1] + 1, p.point[2]] as [number, number, number] };
      const moved = (await s.apply({ ...op, probe: far }).catch((x: unknown) => x)) as CommandEngineError;
      expect(moved.code).toBe("COMMAND_CANDIDATE_CHANGED");
      expect(moved.details).toMatchObject({ reason: "probe" });
    });

    it("renameCurve lists the captures it rewrote but could not verify", async () => {
      const s = await store(plate());
      await captureAll(s);
      // `t` evaluates below its minimum: every tag's feature fails upstream, so no reference
      // resolves and nothing checks the keys the rename writes.
      const doc = JSON.parse(s.document) as { params: Array<{ value: unknown }> };
      doc.params[0]!.value = "1 mm - 2 mm";
      await s.load(JSON.stringify(doc));
      const t = await s.apply({ op: "renameCurve", sketch: "s1", old: "bottom", new: "z" });
      const unverified = (t.ops[0]!.result as { unverified: Array<{ feature: string; reason: string }> }).unverified;
      expect(unverified.map((u) => u.feature).sort()).toEqual(["t_body", "t_vertical"]);
      expect(unverified.every((u) => u.reason === "failed")).toBe(true);
    });

    it("refusals keep the engine's code, errors and details", async () => {
      const s = await store(program("params_plate.json"));
      const bad = async (op: IrOp) => (await s.apply(op).catch((x: unknown) => x)) as CommandEngineError;
      expect((await bad({ op: "setParam", name: "thick", value: "3 deg" })).code).toBe("EXPR_UNIT_MISMATCH");
      const cyc = await bad({ op: "setParam", name: "width", value: "thick + width" });
      expect(cyc.code).toBe("PARAM_CYCLE");
      expect(cyc.errors[0]?.path).toBe("/params/0/value");
      expect((await bad({ op: "setParam", name: "nope", value: 1 })).code).toBe("COMMAND_UNKNOWN_PARAM");
      expect((await bad({ op: "renameCurve", sketch: "s1", old: "nope", new: "x" })).code).toBe("COMMAND_UNKNOWN_CURVE");
      expect((await bad({ op: "renameFeature", feature: "e1", name: "width" })).code).toBe("DUPLICATE_NAME");
      // §9.3: renameFeature never writes a v1 builtin (IR validation only checks v0's list).
      const reserved = await bad({ op: "renameFeature", feature: "e1", name: "X" });
      expect(reserved.code).toBe("RESERVED_NAME");
      expect(reserved.errors[0]?.path).toBe("/parts/0/features/1/name");
      expect(s.getState().history.canUndo).toBe(false);
    });

    it("applyOp without a command engine is ENGINE_UNSUPPORTED", async () => {
      const e = await applyOp(null, "{}", { op: "writeBackSolution" }).catch((x: unknown) => x);
      expect((e as CommandEngineError).code).toBe("ENGINE_UNSUPPORTED");
    });
  });

  describe("commands (palette and agent)", () => {
    it("load, set a parameter, list and repair references, undo and redo through the registry", async () => {
      const h = await makeHarness();
      h.services.ir = new IrDocStore({ engine: () => engine });
      const load = await h.commands.execute({ id: "ir.load", args: { document: ambiguous() } }, { source: "agent" });
      expect(load.ok).toBe(true);

      const set = await h.commands.execute({ id: "ir.setParam", args: { name: "t", value: "4 + 4" } }, { source: "agent" });
      expect(set.ok).toBe(true);
      if (set.ok) expect(set.value.ops[0]!.result).toMatchObject({ previous: 6, value: "4 + 4" });

      const refs = await h.commands.execute({ id: "ir.listRefs", args: { failedOnly: true } }, { source: "agent" });
      expect(refs.ok).toBe(true);
      if (!refs.ok) return;
      const amb = refs.value.find((r) => r.featureId === "t_amb")!;
      expect(amb.entry.code).toBe("REF_AMBIGUOUS");
      const repair = amb.repairs.find((o) => o.op === "acceptRefCandidate")!;
      expect(repair).toBeDefined();
      const fixed = await h.commands.execute({ id: "ir.apply", args: { ops: [repair], label: "Repair t_amb" } }, { source: "agent" });
      expect(fixed.ok).toBe(true);

      // A refused op: FAILED with the engine's machine-readable detail.
      const refused = await h.commands.execute({ id: "ir.captureRef", args: { feature: "t_side", field: "nope" } }, { source: "agent" });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("INVALID_ARGS");
      const refused2 = await h.commands.execute({ id: "ir.renameCurve", args: { sketch: "s1", old: "top", new: "right" } }, { source: "agent" });
      expect(refused2.ok).toBe(false);
      if (!refused2.ok) {
        expect(refused2.error.code).toBe("FAILED");
        expect(refused2.error.detail?.code).toBe("DUPLICATE_ID");
        expect(refused2.error.detail?.errors?.length).toBeGreaterThan(0);
      }

      const state = await h.commands.execute({ id: "ir.state", args: {} });
      expect(state.ok && state.value.history.undoLabel).toBe("Repair t_amb");
      const undo = await h.commands.execute({ id: "ir.undo", args: {} });
      expect(undo.ok && undo.value.undone).toBe(true);
      const redo = await h.commands.execute({ id: "ir.redo", args: {} });
      expect(redo.ok && redo.value.redone).toBe(true);

      // Preview an upgrade without applying it.
      const preview = await h.commands.execute({ id: "ir.upgradeFeature", args: { feature: "e1", preview: true } });
      expect(preview.ok && preview.value).toMatchObject({ preview: true, changed: false });
      // The commands are described for agent tools (JSON Schema of their arguments).
      const described = h.commands.describe().filter((c) => c.id.startsWith("ir."));
      expect(described.map((c) => c.id).sort()).toEqual(
        [
          "ir.acceptRefCandidate",
          "ir.acceptRefProposal",
          "ir.apply",
          "ir.captureRef",
          "ir.listRefs",
          "ir.load",
          "ir.redo",
          "ir.renameCurve",
          "ir.renameFeature",
          "ir.setParam",
          "ir.state",
          "ir.undo",
          "ir.upgradeFeature",
          "ir.writeBackSolution",
        ].sort(),
      );
    });

    it("list only repair ops the engine applies", async () => {
      // A captured union of two faces; a cut then removes one (REF_UNCERTAIN). The other face is
      // listed as a candidate of the lost one (another captured key accounts for it): accepting
      // the cut's face would drop it, so that candidate is not offered.
      const s = await store(twoTops());
      await captureAll(s);
      const doc = JSON.parse(s.document) as { parts: Array<{ features: unknown[] }> };
      doc.parts[0]!.features.splice(
        2,
        0,
        { type: "sketch", id: "s2", name: "cutter", plane: "XY", curves: rectLines(["cb", "cr", "ct", "cl"], -1, 8, 11, 12) },
        { type: "extrude", id: "e2", name: "cut", sketch: "s2", distance: 5, op: "cut", targets: { kind: "body", q: { op: "bodies" } } },
      );
      await s.load(JSON.stringify(doc));
      const loc = refEntries(await s.report(), "t_tops")[0]!;
      expect(loc.entry.code).toBe("REF_UNCERTAIN");
      const offered = repairOps(loc);
      const candidates = offered.flatMap((o) => (o.op === "acceptRefCandidate" ? [o.candidate] : []));
      expect(candidates).not.toContain("e2/side:cb");
      expect(offered.some((o) => o.op === "captureRef")).toBe(false);
      // Every offered op applies.
      for (const op of offered) {
        const t = await s.apply(op);
        expect(t.changed).toBe(true);
        s.undo();
      }
      const refused = (await s.apply({ op: "acceptRefCandidate", feature: "t_tops", field: "/target", member: "e1/side:t1", candidate: "e2/side:cb" }).catch((x: unknown) => x)) as CommandEngineError;
      expect(refused.code).toBe("COMMAND_CANDIDATE_PARTIAL");
    });

    it("offer the proposal, not a capture, for a repaired reference", async () => {
      const s = await store(plate());
      await captureAll(s);
      // `right` renamed by hand (not with renameCurve): t_edge's captured key is gone and the
      // resolver repairs it geometrically (REF_REPAIRED, a member with status "repaired").
      await s.load(s.document.replaceAll('"right"', '"a_right"'));
      const loc = refEntries(await s.report(), "t_edge")[0]!;
      expect(loc.entry.members.some((m) => m.status === "repaired")).toBe(true);
      const offered = repairOps(loc);
      expect(offered).toEqual([{ op: "acceptRefProposal", feature: "t_edge", field: "/target" }]);
      // The engine refuses the capture too: it would drop the repaired member's resolution.
      const refused = (await s.apply({ op: "captureRef", feature: "t_edge", field: "/target" }).catch((x: unknown) => x)) as CommandEngineError;
      expect(refused.code).toBe("COMMAND_REF_REPAIRED");
      expect(refused.details).toMatchObject({ code: "REF_REPAIRED", proposal: true });
      const t = await s.apply(offered[0]!);
      expect(t.changed).toBe(true);
      // An ambiguous reference without a capture offers every candidate.
      const amb = await store(ambiguous());
      const locAmb = refEntries(await amb.report(), "t_amb")[0]!;
      expect(repairOps(locAmb).filter((o) => o.op === "acceptRefCandidate")).toHaveLength(locAmb.entry.unresolved![0]!.candidates.length);
    });

    it("are disabled on hosts without an IR store", async () => {
      const h = await makeHarness();
      const r = await h.commands.execute({ id: "ir.setParam", args: { name: "t", value: 1 } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("DISABLED");
    });
  });

  it("forge-web and its WASM exports refuse non-integer indices and versions, with details", () => {
    const doc = ambiguous();
    const bad = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e as { code: string; details?: Record<string, unknown> };
      }
      throw new Error("expected a refusal");
    };
    for (const i of [1.5, -1, 2 ** 32 + 1, Number.NaN]) {
      const e = bad(() => web.acceptRefCandidate(doc, "t_amb", "/target", "", "e1/edge:x", { candidateIndex: i }));
      expect(e.code, String(i)).toBe("COMMAND_INVALID_ARGUMENT");
      expect(e.details?.["argument"]).toBe("candidateIndex");
      const r = bad(() => raw["acceptRefCandidate"]!(doc, "t_amb", "/target", "", "e1/edge:x", i, undefined));
      expect(r.code, String(i)).toBe("COMMAND_INVALID_ARGUMENT");
      expect(r.details?.["argument"]).toBe("candidateIndex");
    }
    for (const to of [0, -1, 1.9, 2 ** 32]) {
      expect(bad(() => web.upgradeFeature(doc, "e1", to)).code, String(to)).toBe("COMMAND_INVALID_ARGUMENT");
      const r = bad(() => raw["upgradeFeature"]!(doc, "e1", to));
      expect(r.details).toMatchObject({ argument: "to" });
    }
    // setParam: a value that is not JSON (1e400 overflows) is refused with the same details shape.
    const p = bad(() => raw["setParam"]!(program("params_plate.json"), "width", "1e400"));
    expect(p.code).toBe("COMMAND_INVALID_ARGUMENT");
    expect(p.details).toMatchObject({ argument: "value" });
    const q = bad(() => raw["acceptRefCandidate"]!(doc, "t_amb", "/target", "", "e1/edge:x", undefined, "{ nope"));
    expect(q.details).toMatchObject({ argument: "probe" });
  });

  it("ops validate their arguments", () => {
    expect(IrOpSchema.safeParse({ op: "captureRef", feature: "t", field: "target" }).success).toBe(false);
    expect(IrOpSchema.safeParse({ op: "setParam", name: "t", value: Number.NaN }).success).toBe(false);
    expect(IrOpSchema.safeParse({ op: "upgradeFeature", feature: "e1", to: 0 }).success).toBe(false);
    expect(IrOpSchema.safeParse({ op: "renameCurve", sketch: "s1", old: "a", new: "b" }).success).toBe(true);
    const candidate = { op: "acceptRefCandidate", feature: "t", field: "/target", member: "", candidate: "e1/side:top" };
    expect(IrOpSchema.safeParse({ ...candidate, probe: { kind: "face", point: [0, 0, 1], normal: [0, 0, 1] } }).success).toBe(true);
    expect(IrOpSchema.safeParse({ ...candidate, probe: { kind: "face", point: [0, 0] } }).success).toBe(false);
    expect(IrOpSchema.safeParse({ ...candidate, candidateIndex: 1.5 }).success).toBe(false);
  });
});

describe("IR v1 DocStore transactions (text engine)", () => {
  it("are atomic when a refused op was not awaited: the transaction rejects with its code and records nothing", async () => {
    const s = new IrDocStore({ engine: () => textEngine() });
    await s.load("DOC;");
    const e = await s
      .transaction("t", async (tx) => {
        void tx.apply({ op: "setParam", name: "a", value: 1 });
        void tx.apply({ op: "setParam", name: "bad", value: 2 });
      })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CommandEngineError);
    expect((e as CommandEngineError).code).toBe("COMMAND_UNKNOWN_PARAM");
    expect(s.document).toBe("DOC;");
    expect(s.getState().history.canUndo).toBe(false);
    // A refusal the callback caught refuses the transaction too.
    const caught = await s
      .transaction("t2", async (tx) => {
        await tx.apply({ op: "setParam", name: "a", value: 1 });
        await tx.apply({ op: "setParam", name: "bad", value: 2 }).catch(() => undefined);
      })
      .catch((x: unknown) => x);
    expect((caught as CommandEngineError).code).toBe("COMMAND_UNKNOWN_PARAM");
    expect(s.document).toBe("DOC;");
    expect(s.getState().history.canUndo).toBe(false);
    // Without a refusal, ops started without awaiting them commit, in call order, as one step.
    const ok = await s.transaction("t3", async (tx) => {
      void tx.apply({ op: "setParam", name: "a", value: 1 });
      void tx.apply({ op: "setParam", name: "b", value: 2 });
    });
    expect(ok.changed).toBe(true);
    expect(s.document).toBe("DOC;a=1;b=2;");
    expect(s.undo()).toBe(true);
    expect(s.document).toBe("DOC;");
  });

  it("commit the edit without a write-back the engine refuses, and say why", async () => {
    const refuse = () =>
      Promise.reject(new CommandEngineError("COMMAND_NOT_EXACT", "no fixed point", [], { op: "writeBackSolution", reason: "no fixed point" }));
    const s = new IrDocStore({ engine: () => textEngine(refuse) });
    await s.load("DOC;");
    const t = await s.apply({ op: "setParam", name: "a", value: 1 });
    expect(t.changed).toBe(true);
    expect(s.document).toBe("DOC;a=1;");
    expect(t.writeBackSkipped).toMatchObject({ code: "COMMAND_NOT_EXACT", details: { reason: "no fixed point" } });
    // The explicit op is still refused.
    const e = (await s.apply({ op: "writeBackSolution" }).catch((x: unknown) => x)) as CommandEngineError;
    expect(e.code).toBe("COMMAND_NOT_EXACT");
    expect(s.document).toBe("DOC;a=1;");
  });
});

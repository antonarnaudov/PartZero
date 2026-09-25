/// <reference types="node" />
/**
 * The CadScript bridge end to end without the UI: the real sketch session, the real CadScript
 * compiler and splicer (`applyIrEdit`, what `doc.applyIr` runs) and the real Forge evaluator
 * (`@aicad/forge-web`'s WASM `evaluate`). A finished sketch lands in the source as a `sketch(…)`
 * statement, extrudes into a body of the right volume, and reopens with its constraints.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyIrEdit, compile } from "@aicad/cadscript";
import type { EvalReport, IrDocument } from "@aicad/ir-types";
import { EMPTY_CONTEXT } from "../../src/sketch/context";
import { SketchMode } from "../../src/sketch/controller";
import { namedFrame } from "../../src/sketch/frames";
import type { P2 } from "../../src/sketch/geom";
import { newSketchOptions } from "../../src/sketch/integration";
import { CadScriptSketchSink, lowerSketch, placeFeature, regionCheck, v0DocContext, type CadScriptDocPort } from "../../src/sketch/v0-bridge";
import { PlaneView } from "../../src/sketch/view";
import { engines } from "./harness";

const require = createRequire(import.meta.url);
const forgeWeb = dirname(require.resolve("@aicad/forge-web/package.json"));
let evaluate: (irJson: string) => unknown;

beforeAll(async () => {
  const m = (await import(join(forgeWeb, "pkg/forge_wasm.js"))) as { initSync(o: { module: Buffer }): unknown; evaluate(irJson: string): unknown };
  m.initSync({ module: readFileSync(join(forgeWeb, "pkg/forge_wasm_bg.wasm")) });
  evaluate = m.evaluate;
});

/** The Forge evaluation report of a v0 document. */
function evalReport(ir: IrDocument): EvalReport {
  return (evaluate(JSON.stringify(ir)) as { report: EvalReport }).report;
}

const BLANK = `import { doc, part, sketch, line, circle, extrude, revolve, XY, XZ, YZ } from "@aicad/std";

doc({ name: "untitled", description: "" });

part("part");
const base = sketch(XY, {
  bottom: line([-20, -15], [20, -15]),
  right: line([20, -15], [20, 15]),
  top: line([20, 15], [-20, 15]),
  left: line([-20, 15], [-20, -15]),
});
const block = extrude(base, { distance: 10 });
`;

/** A document port over a CadScript source, like the app's DocStore + `doc.applyIr`. */
class SourcePort implements CadScriptDocPort {
  source: string;
  private ir: IrDocument | null = null;
  selected: string[] = [];
  labels: string[] = [];

  constructor(source: string) {
    this.source = source;
    this.recompile();
  }

  private recompile(): { ok: boolean; ir: IrDocument | null } {
    const c = compile(this.source, this.ir ? { base: this.ir } : {});
    if (c.ok && c.ir) this.ir = c.ir;
    return { ok: c.ok, ir: c.ok ? c.ir : null };
  }

  model(): IrDocument | null {
    return this.ir;
  }

  async settled(): Promise<{ ir: IrDocument | null; report: EvalReport | null; error?: string }> {
    const c = this.recompile();
    if (!c.ok || !c.ir) return { ir: null, report: null, error: "the code has errors: fix them first" };
    return { ir: c.ir, report: evalReport(c.ir) };
  }

  async applyIr(ir: IrDocument, label: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      this.source = applyIrEdit(this.source, this.ir!, ir);
      this.labels.push(label);
      this.recompile();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async selectFeature(nameOrId: string): Promise<void> {
    this.selected.push(nameOrId);
  }

  async report(): Promise<EvalReport> {
    return (await this.settled()).report!;
  }
}

const XY = { ref: "XY" as const, frame: namedFrame("XY"), label: "XY plane" };

function driver(mode: SketchMode): { click(p: P2, alt?: boolean): void; type(t: string): void } {
  return {
    click(p, alt = false) {
      const px = new PlaneView(mode.getState().view).toScreen(p);
      const e = { px, button: 0, shift: false, alt, ctrl: false, meta: false, clicks: 1 };
      mode.pointerMove(e);
      mode.pointerDown(e);
      mode.pointerUp(e);
    },
    type(t) {
      for (const ch of t) mode.key({ key: ch, mod: false, shift: false, alt: false, editable: false });
      mode.setTypedText(t);
    },
  };
}

function bodyVolume(report: EvalReport, feature: string, ir: IrDocument): number {
  // Report entries name their feature (and part) by name.
  expect(ir.parts.flatMap((p) => p.features).some((f) => f.name === feature)).toBe(true);
  const entry = report.features.find((f) => f.feature === feature)!;
  expect(entry.status).toBe("ok");
  return (entry.bodies ?? []).reduce((a, b) => a + b.volume, 0);
}

describe("the CadScript bridge", () => {
  it("adds a finished sketch to the document, extrudes it, and edits it with its constraints kept", async () => {
    const port = new SourcePort(BLANK);
    const sink = new CadScriptSketchSink(port);
    const mode = new SketchMode(engines, sink);
    mode.setViewport(1000, 800);
    const d = driver(mode);

    // New sketch: a free name against the document (base and block are taken).
    expect(await mode.begin(newSketchOptions(XY, EMPTY_CONTEXT, v0DocContext(port.model())))).toBe(true);
    expect(mode.getState().sketchName).toBe("sketch1");
    mode.setTool("circleCenter");
    d.click([40, 0]);
    d.click([46, 0]);
    // Dimension the radius: 6 → a parameter `r = 8`.
    mode.setTool("dimension");
    d.click([40 + 6 * Math.SQRT1_2, 6 * Math.SQRT1_2]);
    d.click([55, 8]);
    const kind = mode.getState().dimEdit?.proposal?.shape.type;
    expect(kind).toMatch(/^(radius|diameter)$/);
    const k = kind === "radius" ? 1 : 2; // the dimension's value per mm of radius
    mode.setDimText(`r = ${8 * k}`);
    expect(mode.commitDimension(), mode.getState().dimEdit?.error ?? "").toBe(true);
    const f = await mode.finish({ force: true });
    expect(f).not.toBeNull();
    expect(mode.getState().phase).toBe("off");
    expect(mode.getState().finishedNote?.note).toMatch(/Saved in the CadScript document.*1 constraint.*parameter r/);
    expect(mode.getState().finishedNote?.warning).toBeNull();
    expect(port.source).toMatch(/const sketch1 = sketch\(XY, \{/);
    expect(port.source).toContain("circle({ center: [40, 0], radius: 8 })");
    expect(port.selected).toContain("sketch1");
    // The untouched statements keep their text.
    expect(port.source).toContain("const block = extrude(base, { distance: 10 });");

    // Extrude it: a cylinder of volume π·8²·5.
    const ex = await sink.extrude("sketch1", 5, "normal");
    expect(ex).toMatchObject({ ok: true, note: "extrude1: 1 body." });
    expect(port.source).toContain("const extrude1 = extrude(sketch1, { distance: 5 });");
    let report = await port.report();
    expect(bodyVolume(report, "extrude1", port.model()!)).toBeCloseTo(Math.PI * 64 * 5, 6);

    // Reopen it: the radius dimension bound to `r` comes back; change r to 10.
    const o = sink.editOptions("sketch1", EMPTY_CONTEXT)!;
    expect(o.notice).toBeNull();
    expect(await mode.begin(o)).toBe(true);
    expect(mode.getState().mode).toBe("edit");
    const rDim = mode.getState().snapshot!.constraints.find((c) => c.expr === "r")!;
    expect(rDim.measured).toBeCloseTo(8 * k, 9);
    mode.editDimension(rDim.id);
    mode.setDimText(`r2 = ${10 * k}`);
    expect(mode.commitDimension()).toBe(true);
    expect(await mode.finish({ force: true })).not.toBeNull();
    expect(port.source.match(/const sketch1 = /g)).toHaveLength(1);
    expect(port.source).toContain("radius: 10");
    report = await port.report();
    expect(bodyVolume(report, "extrude1", port.model()!)).toBeCloseTo(Math.PI * 100 * 5, 6);
    expect(port.labels).toEqual(["Add sketch sketch1", "Extrude sketch1", "Edit sketch sketch1"]);
  });

  it("opens a sketch it did not write as plain geometry, and edits it in place", async () => {
    const port = new SourcePort(BLANK);
    const sink = new CadScriptSketchSink(port);
    const mode = new SketchMode(engines, sink);
    mode.setViewport(1000, 800);
    const o = sink.editOptions("base", EMPTY_CONTEXT)!;
    expect(o.notice).toMatch(/geometry only/);
    expect(o.plane.ref).toBe("XY");
    expect(await mode.begin(o)).toBe(true);
    const s = mode.getState();
    expect(s.notice?.text).toMatch(/geometry only/);
    expect(s.snapshot!.curves).toHaveLength(4);
    // Dimension the bottom edge to 50 (it was 40), fixing its left end so it grows to the right.
    const d = driver(mode);
    mode.select([{ kind: "point", ref: "bottom.start" }]);
    expect(mode.constrain("fix")).toBe(true);
    mode.select([{ kind: "curve", id: "bottom" }, { kind: "curve", id: "top" }]);
    expect(mode.constrain("horizontal")).toBe(true);
    mode.select([{ kind: "curve", id: "left" }, { kind: "curve", id: "right" }]);
    expect(mode.constrain("vertical")).toBe(true);
    mode.setTool("dimension");
    d.click([0, -15]);
    d.click([0, -25]);
    mode.setDimText("50");
    expect(mode.commitDimension()).toBe(true);
    expect(await mode.finish({ force: true })).not.toBeNull();
    expect(port.source).toContain("bottom: line([-20, -15], [30, -15])");
    const report = await port.report();
    expect(bodyVolume(report, "block", port.model()!)).toBeCloseTo(50 * 30 * 10, 6);
  });

  it("refuses to splice into code with errors, and keeps the sketch open", async () => {
    const port = new SourcePort(BLANK + "const broken = ;\n");
    const sink = new CadScriptSketchSink(port);
    const mode = new SketchMode(engines, sink);
    mode.setViewport(1000, 800);
    expect(await mode.begin(newSketchOptions(XY, EMPTY_CONTEXT, v0DocContext(port.model())))).toBe(true);
    const d = driver(mode);
    mode.setTool("circleCenter");
    d.click([40, 0]);
    d.click([46, 0]);
    expect(await mode.finish({ force: true })).toBeNull();
    expect(mode.getState().phase).toBe("active");
    expect(mode.getState().notice?.text).toMatch(/did not accept the sketch: the code has errors/);
  });

  it("lowers only what a v0 document holds, and places features after their predecessor", async () => {
    const mode = new SketchMode(engines);
    mode.setViewport(1000, 800);
    expect(await mode.begin({ plane: { ref: "XZ", frame: namedFrame("XZ"), label: "XZ" }, id: "s", name: "s" })).toBe(true);
    const d = driver(mode);
    mode.setTool("rectCenter"); // 4 lines + a construction diagonal + a construction point
    d.click([0, 0], true);
    d.click([10, 5], true);
    const f = (await mode.finish())!;
    const low = lowerSketch(f, "f_s");
    expect(low.ok).toBe(true);
    if (!low.ok) return;
    expect(low.value.feature.plane).toBe("XZ");
    expect(low.value.feature.curves.map((c) => c.kind)).toEqual(["line", "line", "line", "line"]);
    expect(low.value.omitted).toMatchObject({ construction: 1, points: 1 });
    expect(low.value.omitted.constraints).toBeGreaterThan(0);

    const ir = compile(BLANK).ir!;
    const after = placeFeature(ir, low.value.feature, { mode: "new", part: null, after: "base" });
    expect(after.ok && after.value.parts[0]!.features.map((x) => x.name)).toEqual(["base", "s", "block"]);
    const end = placeFeature(ir, low.value.feature, { mode: "new", part: null, after: null });
    expect(end.ok && end.value.parts[0]!.features.map((x) => x.name)).toEqual(["base", "block", "s"]);
    const empty = placeFeature({ schema: "aicad.ir/0", parts: [] }, low.value.feature, { mode: "new", part: null, after: null });
    expect(empty.ok && empty.value.parts).toEqual([{ id: "p_part", name: "part", features: [low.value.feature] }]);
    const gone = placeFeature(ir, { ...low.value.feature, id: "nope" }, { mode: "edit", part: null, after: null });
    expect(gone.ok).toBe(false);

    // Face planes and expressions are refused with a reason, not written wrong.
    const face = lowerSketch({ ...f, feature: { ...f.feature, plane: { face: { query: "x" } } as never } }, "f_s");
    expect(face).toMatchObject({ ok: false, message: expect.stringMatching(/face or a datum/) as string });
  });

  it("reports when the document evaluates a sketch differently from the sketcher", () => {
    const ir = compile(BLANK).ir!;
    const r = evalReport(ir);
    expect(regionCheck(r, ir, "base", { ok: true, areas: [1200] })).toBeNull();
    expect(regionCheck(r, ir, "base", { ok: true, areas: [1200, 3] })).toMatch(/finds 1 region in base.*the sketcher found 2/);
  });
});

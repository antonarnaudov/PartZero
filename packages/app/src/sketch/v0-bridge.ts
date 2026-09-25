/**
 * The CadScript bridge: finished sketches go into the open CadScript (IR v0) document **today**,
 * through the command layer's `doc.applyIr` (spliced into the source as one undoable transaction:
 * the timeline shows the sketch, ⌘Z removes it, Save writes it), and the timeline's sketches open
 * in the sketcher again.
 *
 * It is the interim sink until the IR v1 command layer exists: Finish on the v1 model needs the op
 * catalogue v2 (contract C1 part 1: `addParam`, `addFeature`, `setField`; part 2: `sketchEdit`),
 * which Phase C does not have (docs/fm/sketcher.md). When C1 lands, the integrator installs the v1
 * sink instead (`sketchMode.setSink`) and this file goes.
 *
 * What an IR v0 document can hold, and what it cannot (said in the Finish toast, never silent):
 * - **Kept:** the solved geometry of the profile curves (lines, arcs, circles) on XY/XZ/YZ or an
 *   explicit frame, to the nanometre ({@link WRITE_DECIMALS}). Region counts and areas are checked against the document's own evaluation
 *   after the edit; a difference is reported as a warning.
 * - **Not in the file:** construction curves, points, constraints, dimensions and parameters.
 *   While the window is open, {@link SketchIntentMemory} keeps them: reopening a sketch whose
 *   geometry is unchanged restores its constraints, dimensions and parameters. A sketch changed
 *   elsewhere (code, agent) or reopened after a restart opens as plain geometry.
 */
import type { EvalReport, Feature, IrDocument, PartStudio, PlaneSpec, SketchCurve as V0Curve, SketchFeature as V0Sketch, SweepDirection } from "@aicad/ir-types";
import type { v1 } from "@aicad/ir-types";
import type { CommitOutcome, SketchCommitSink, SketchFinish } from "./commit";
import type { BeginOptions, SketchPlaneChoice } from "./controller";
import { cross3, namedFrame, type Frame3, type V3 } from "./frames";
import type { SketchDocContext } from "./integration";
import { nextName } from "./names";

// ─── The document port ─────────────────────────────────────────────────────────────────────

/** What the bridge needs from the app: the v0 DocStore and two commands. */
export interface CadScriptDocPort {
  /** The last successfully compiled IR, now (null before the first compile). */
  model(): IrDocument | null;
  /**
   * Wait for the pipeline to settle, then the IR of the current source and its report; `error`
   * when the code does not compile (the bridge cannot splice into it).
   */
  settled(): Promise<{ ir: IrDocument | null; report: EvalReport | null; error?: string }>;
  /** Run `doc.applyIr` (the command layer): one undoable transaction on the source. */
  applyIr(ir: IrDocument, label: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Run `selection.selectFeature` (reveals it in the timeline and the code). */
  selectFeature(nameOrId: string): Promise<void>;
}

// ─── Lowering: an IR v1 sketch feature → an IR v0 sketch feature ───────────────────────────

export interface Lowered {
  feature: V0Sketch;
  /** What the v0 document cannot hold. */
  omitted: { construction: number; points: number; constraints: number; params: string[] };
}

type Result<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Coordinates are written to the nanometre (1e-9 mm, a thousandth of the kernel's linear
 * tolerance): the file reads `radius: 8`, not the solver's `7.999999999999333`. Equal inputs give
 * equal outputs, so welded ends stay bit-identical.
 */
export const WRITE_DECIMALS = 9;

function num(s: v1.Scalar): number | null {
  if (typeof s !== "number" || !Number.isFinite(s)) return null;
  return Number(s.toFixed(WRITE_DECIMALS)) + 0;
}

function p2(p: readonly v1.Scalar[]): [number, number] | null {
  const x = num(p[0]!);
  const y = num(p[1]!);
  return x === null || y === null ? null : [x, y];
}

function lowerPlane(plane: v1.PlaneRef): Result<PlaneSpec> {
  if (plane === "XY" || plane === "XZ" || plane === "YZ") return { ok: true, value: plane };
  if (typeof plane === "object" && plane !== null && "origin" in plane && "normal" in plane && "x_dir" in plane) {
    const f = plane as v1.FramePlane;
    const v = [...f.origin, ...f.normal, ...f.x_dir].map(num);
    if (v.every((x): x is number => x !== null)) {
      return { ok: true, value: { origin: [v[0]!, v[1]!, v[2]!], normal: [v[3]!, v[4]!, v[5]!], x_dir: [v[6]!, v[7]!, v[8]!] } };
    }
    return { ok: false, message: "the sketch plane uses expressions, which a CadScript v0 document cannot hold" };
  }
  return { ok: false, message: "a sketch on a face or a datum plane needs the IR v1 model (not merged yet)" };
}

/**
 * The v0 form of a finished sketch: its profile curves with their literal (solved) geometry, under
 * the v0 feature id `id`. Refused, with the reason, when the sketch has something v0 cannot
 * express (expression coordinates, compound curves, a face plane).
 */
export function lowerSketch(f: SketchFinish, id: string): Result<Lowered> {
  const plane = lowerPlane(f.feature.plane);
  if (!plane.ok) return plane;
  const curves: V0Curve[] = [];
  const omitted: Lowered["omitted"] = { construction: 0, points: 0, constraints: (f.feature.constraints ?? []).length, params: f.params.map((p) => p.name) };
  const exprs = (): Result<Lowered> => ({ ok: false, message: "the sketch has expression coordinates, which a CadScript v0 document cannot hold" });
  for (const c of f.feature.curves) {
    if (c.kind === "point") {
      omitted.points++;
      continue;
    }
    if ("construction" in c && c.construction) {
      omitted.construction++;
      continue;
    }
    switch (c.kind) {
      case "line": {
        const start = p2(c.start);
        const end = p2(c.end);
        if (!start || !end) return exprs();
        curves.push({ kind: "line", id: c.id, start, end });
        break;
      }
      case "arc": {
        const start = p2(c.start);
        const end = p2(c.end);
        const center = p2(c.center);
        if (!start || !end || !center) return exprs();
        curves.push({ kind: "arc", id: c.id, start, end, center, ccw: c.ccw });
        break;
      }
      case "circle": {
        const center = p2(c.center);
        const radius = num(c.radius);
        if (!center || radius === null) return exprs();
        curves.push({ kind: "circle", id: c.id, center, radius });
        break;
      }
      default:
        return { ok: false, message: `a ${c.kind} curve must be converted first (it is a compound curve)` };
    }
  }
  return { ok: true, value: { feature: { type: "sketch", id, name: f.feature.name, plane: plane.value, curves }, omitted } };
}

/** The v1 (explicit) form of a v0 sketch, for the sketch session: the same curves and plane. */
export function liftSketch(s: V0Sketch): v1.SketchFeature {
  const plane: v1.PlaneRef = typeof s.plane === "string" ? s.plane : { origin: [...s.plane.origin], normal: [...s.plane.normal], x_dir: [...s.plane.x_dir] };
  return { type: "sketch", id: s.id, name: s.name, plane, curves: s.curves.map((c) => ({ ...c }) as v1.SketchCurve) };
}

/** The display frame of a v0 plane (SPEC v0 §2). */
export function planeFrame(plane: PlaneSpec): Frame3 {
  if (typeof plane === "string") return namedFrame(plane);
  const unit = (a: V3): V3 => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const n = unit(plane.normal);
  const d = plane.x_dir[0] * n[0] + plane.x_dir[1] * n[1] + plane.x_dir[2] * n[2];
  const x = unit([plane.x_dir[0] - d * n[0], plane.x_dir[1] - d * n[1], plane.x_dir[2] - d * n[2]]);
  return { origin: [...plane.origin], x, y: cross3(n, x), normal: n };
}

// ─── Placing features in the v0 document ───────────────────────────────────────────────────

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Every feature id and name, and part id and name, in a v0 document. */
export function v0Names(ir: IrDocument | null): string[] {
  const out: string[] = [];
  for (const p of ir?.parts ?? []) {
    out.push(p.id, p.name);
    for (const f of p.features) out.push(f.id, f.name);
  }
  return out;
}

/** The v0 sketch (and its part) with this id or name. */
export function findV0Sketch(ir: IrDocument | null, idOrName: string): { part: PartStudio; feature: V0Sketch } | null {
  for (const part of ir?.parts ?? []) {
    for (const f of part.features) if (f.type === "sketch" && (f.id === idOrName || f.name === idOrName)) return { part, feature: f };
  }
  return null;
}

/**
 * `ir` with `feature` added (after `after` in `part`, else at the end of that part or the first
 * one; a document without parts gets `part("part")`), or replacing the feature with its id.
 */
export function placeFeature(ir: IrDocument, feature: Feature, how: { mode: "new" | "edit"; part: string | null; after: string | null }): Result<IrDocument> {
  const out = clone(ir);
  if (how.mode === "edit") {
    for (const part of out.parts) {
      const k = part.features.findIndex((f) => f.id === feature.id);
      if (k < 0) continue;
      const old = part.features[k]!;
      if (old.type !== feature.type) return { ok: false, message: `${feature.id} is a ${old.type}, not a ${feature.type}` };
      part.features[k] = { ...feature, ...(old.suppressed ? { suppressed: true } : {}) } as Feature;
      return { ok: true, value: out };
    }
    return { ok: false, message: `the document has no feature ${feature.id} any more` };
  }
  if (out.parts.length === 0) out.parts.push({ id: "p_part", name: "part", features: [] });
  const part = (how.part ? out.parts.find((p) => p.id === how.part || p.name === how.part) : undefined) ?? out.parts[0]!;
  const k = how.after ? part.features.findIndex((f) => f.id === how.after || f.name === how.after) : -1;
  if (k >= 0) part.features.splice(k + 1, 0, feature);
  else part.features.push(feature);
  return { ok: true, value: out };
}

/** A fresh v0 feature id for `name` (`f_<name>`, CadScript's own convention). */
function freshId(ir: IrDocument, name: string): string {
  const taken = new Set(v0Names(ir));
  if (!taken.has(`f_${name}`)) return `f_${name}`;
  return nextName(`f_${name}_`, taken);
}

// ─── Region check ──────────────────────────────────────────────────────────────────────────

/** Compare the document's evaluation of the sketch with what the sketcher computed. */
export function regionCheck(report: EvalReport | null, ir: IrDocument | null, name: string, expected: { ok: boolean; areas: readonly number[] }): string | null {
  const loc = findV0Sketch(ir, name);
  if (!loc || !report) return null;
  const entry = report.features.find((r) => r.feature === loc.feature.id || r.feature === loc.feature.name);
  if (!entry) return null;
  if (entry.status !== "ok") {
    const code = entry.error?.code ?? "an error";
    return expected.ok ? `The CadScript document evaluates ${name} with ${code}, although the sketcher solved it: check the sketch.` : null;
  }
  const got = [...(entry.regions ?? []).map((r) => r.area)].sort((a, b) => a - b);
  const want = [...expected.areas].sort((a, b) => a - b);
  const same = got.length === want.length && got.every((a, i) => Math.abs(a - want[i]!) <= 1e-6 * Math.max(1, Math.abs(a)));
  if (same) return null;
  return `The CadScript document finds ${got.length} region${got.length === 1 ? "" : "s"} in ${name} (areas ${got.map((a) => a.toFixed(3)).join(", ") || "none"}); the sketcher found ${want.length} (${want.map((a) => a.toFixed(3)).join(", ") || "none"}). Check the sketch.`;
}

// ─── Design intent kept while the window is open ───────────────────────────────────────────

interface Remembered {
  /** The v0 geometry as written (plane and curves). */
  geometry: string;
  /** The v1 sketch with its constraints and dimensions. */
  sketch: v1.SketchFeature;
  /** The parameters its dimensions use. */
  params: v1.Parameter[];
}

/**
 * Constraints, dimensions and parameters of the sketches finished in this window (an IR v0 file
 * cannot hold them), keyed by the sketch's name, valid while its geometry in the document is the
 * geometry written.
 */
export class SketchIntentMemory {
  private readonly byName = new Map<string, Remembered>();

  /** Canonical JSON of the plane and curves (sorted keys: the compiled IR may order them differently). */
  private static geometry(s: V0Sketch): string {
    const canon = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
    return JSON.stringify(canon({ plane: s.plane, curves: s.curves }));
  }

  remember(written: V0Sketch, sketch: v1.SketchFeature, params: readonly v1.Parameter[]): void {
    const prev = this.byName.get(written.name);
    const all = new Map((prev?.params ?? []).map((p) => [p.name, p]));
    for (const p of params) all.set(p.name, p);
    this.byName.set(written.name, { geometry: SketchIntentMemory.geometry(written), sketch: clone(sketch), params: [...all.values()] });
  }

  /** The remembered sketch for the document's current `s`, if its geometry is unchanged. */
  recall(s: V0Sketch): { sketch: v1.SketchFeature; params: v1.Parameter[] } | null {
    const r = this.byName.get(s.name);
    if (!r || r.geometry !== SketchIntentMemory.geometry(s)) return null;
    return { sketch: { ...clone(r.sketch), id: s.id, name: s.name }, params: clone(r.params) };
  }
}

// ─── The sink and the edit path ────────────────────────────────────────────────────────────

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A v1 document carrying `params`, for the session (a v0 document has no parameters). */
function paramsDocument(params: readonly v1.Parameter[], part: string): v1.IrDocument {
  return { schema: "aicad.ir/1", params: clone([...params]), parts: [{ id: part, name: part, features: [] }] } as unknown as v1.IrDocument;
}

export class CadScriptSketchSink implements SketchCommitSink {
  constructor(
    private readonly port: CadScriptDocPort,
    readonly memory = new SketchIntentMemory(),
  ) {}

  async commit(f: SketchFinish): Promise<CommitOutcome> {
    const now = await this.port.settled();
    if (!now.ir) return { ok: false, message: now.error ?? "the document has no model to add the sketch to" };
    const id = f.mode === "edit" ? f.feature.id : freshId(now.ir, f.feature.name);
    const low = lowerSketch(f, id);
    if (!low.ok) return { ok: false, message: low.message };
    const placed = placeFeature(now.ir, low.value.feature, { mode: f.mode, part: f.part, after: f.after });
    if (!placed.ok) return { ok: false, message: placed.message };
    const r = await this.port.applyIr(placed.value, `${f.mode === "new" ? "Add" : "Edit"} sketch ${f.feature.name}`);
    if (!r.ok) return r;
    this.memory.remember(low.value.feature, f.feature, f.params);
    const after = await this.port.settled();
    const warning = regionCheck(after.report, after.ir, f.feature.name, { ok: f.check.ok, areas: f.check.areas ?? [] });
    await this.port.selectFeature(f.feature.name).catch(() => undefined);
    const o = low.value.omitted;
    const kept: string[] = [];
    if (o.constraints) kept.push(plural(o.constraints, "constraint"));
    if (o.params.length) kept.push(`parameter${o.params.length === 1 ? "" : "s"} ${o.params.join(", ")}`);
    if (o.construction) kept.push(plural(o.construction, "construction curve"));
    if (o.points) kept.push(plural(o.points, "point"));
    const note = kept.length
      ? `Saved in the CadScript document as its solved geometry. Its ${kept.join(", ")} stay with it while this window is open (a v0 file stores geometry only).`
      : "Saved in the CadScript document.";
    return { ok: true, note, ...(warning ? { warning } : {}) };
  }

  /**
   * The `begin` options to edit the document's sketch `idOrName`: its remembered constraints
   * (unchanged geometry) or its plain geometry. Null when it is not a sketch of the document.
   */
  editOptions(idOrName: string, context: BeginOptions["context"]): (BeginOptions & { notice: string | null }) | null {
    const loc = findV0Sketch(this.port.model(), idOrName);
    if (!loc) return null;
    const plane: SketchPlaneChoice = {
      ref: liftSketch(loc.feature).plane,
      frame: planeFrame(loc.feature.plane),
      label: typeof loc.feature.plane === "string" ? `${loc.feature.plane} plane` : "frame",
    };
    const recalled = this.memory.recall(loc.feature);
    const sketch = recalled?.sketch ?? liftSketch(loc.feature);
    return {
      plane,
      sketch,
      part: loc.part.id,
      document: paramsDocument(recalled?.params ?? [], loc.part.id),
      ...(context ? { context } : {}),
      notice: recalled ? null : "Opened from the CadScript document, which stores this sketch's geometry only: add constraints and dimensions as needed.",
    };
  }

  /** Extrude a sketch of the document (`doc.applyIr`): the quick follow-up to Finish. */
  async extrude(sketchName: string, distance: number, direction: SweepDirection): Promise<CommitOutcome> {
    if (!(distance > 0) || !Number.isFinite(distance)) return { ok: false, message: "The distance must be greater than zero." };
    const now = await this.port.settled();
    if (!now.ir) return { ok: false, message: now.error ?? "the document has no model" };
    const loc = findV0Sketch(now.ir, sketchName);
    if (!loc) return { ok: false, message: `the document has no sketch ${sketchName}` };
    const name = nextName("extrude", v0Names(now.ir));
    const feature: Feature = { type: "extrude", id: freshId(now.ir, name), name, sketch: loc.feature.name, distance, ...(direction !== "normal" ? { direction } : {}) };
    const placed = placeFeature(now.ir, feature, { mode: "new", part: loc.part.id, after: loc.feature.id });
    if (!placed.ok) return { ok: false, message: placed.message };
    const r = await this.port.applyIr(placed.value, `Extrude ${loc.feature.name}`);
    if (!r.ok) return r;
    const after = await this.port.settled();
    const entry = after.report?.features.find((x) => x.feature === name || findV0Feature(after.ir, name)?.id === x.feature);
    await this.port.selectFeature(name).catch(() => undefined);
    if (entry && entry.status !== "ok") return { ok: true, warning: `${name} failed: ${entry.error?.code ?? "error"} ${entry.error?.message ?? ""}`.trim() };
    const bodies = entry?.bodies?.length ?? 0;
    return { ok: true, note: `${name}: ${plural(bodies, "body", "bodies")}.` };
  }
}

function findV0Feature(ir: IrDocument | null, name: string): Feature | null {
  for (const p of ir?.parts ?? []) for (const f of p.features) if (f.name === name || f.id === name) return f;
  return null;
}

/** The document context of a new sketch in a v0 document: no parameters, the first part, free names. */
export function v0DocContext(ir: IrDocument | null): SketchDocContext {
  return { document: null, part: ir?.parts[0]?.id ?? null, after: null, taken: v0Names(ir) };
}

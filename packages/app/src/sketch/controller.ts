/**
 * Sketch mode (plan §2.7): the state machine the sketch UI renders, and the one place that talks
 * to the sketch session.
 *
 * ```text
 * off ─requestNew─► choosePlane ─begin(plane)─► loading ─► active ─finish/cancel─► off
 *                                     edit(sketch) ─┘        │ tools → gestures → session.apply (one edit batch each)
 *                                                            │ select tool drags → session.drag* (per frame)
 *                                                            └ dimensions, constraints, undo/redo (session-level)
 * ```
 *
 * The session is the cache and the solver; the IR is the truth. Finishing hands the IR v1 sketch
 * feature to the {@link SketchCommitSink}, which the integrator connects to the command layer.
 * Everything here is framework-free and unit-tested against the real WASM session.
 */
import type { v1 } from "@aicad/ir-types";
import type {
  ApplyOptions,
  ApplyResult,
  FinishResult,
  LiteralCurve,
  SketchEdit,
  SketchLoadRequest,
  SketchSnapshot,
} from "./engine-types";
import { Store } from "../store";
import { createTool, toolInfo, SKETCH_TOOLS, type SketchTool, type ToolId } from "../tools/sketch";
import { DimensionTool } from "../tools/sketch/dimension";
import { EMPTY_PREVIEW, type PointerIn, type SnapOptions, type ToolApi, type ToolPreview } from "../tools/sketch/types";
import { MemorySink, type SketchCommitSink, type SketchFinish } from "./commit";
import { constraintsFor, refPoint, type ConstraintKind, type SketchSel } from "./constraints";
import { EMPTY_CONTEXT, type ContextGeometry } from "./context";
import { dimensionConstraint, type DimProposal } from "./dimension";
import type { Frame3 } from "./frames";
import { bounds, curvePoint, dist, fmt, nearestOnCurve, type P2 } from "./geom";
import { IdAllocator, isId } from "./ids";
import { namesIn, nextSketchName } from "./names";
import { snap } from "./snap";
import { fitBox, initialView, isTrackpadPan, pan, PlaneView, zoomAt, type ViewState } from "./view";

/** The subset of `@aicad/forge-web/sketch`'s `SketchSession` sketch mode uses. */
export interface SketchEngine {
  snapshot(): SketchSnapshot;
  apply(edits: readonly SketchEdit[], options?: ApplyOptions): ApplyResult;
  undo(): SketchSnapshot;
  redo(): SketchSnapshot;
  dragBegin(spec: { target: string; grab: P2; mode?: "rim" }): { ok: true } | { ok: false; error: { code: string; message: string } };
  dragTo(u: number, v: number): { ok: true; frame: { converged: boolean; curves: LiteralCurve[]; targetError: number } } | { ok: false; error: { code: string; message: string } };
  dragEnd(): ApplyResult;
  dragCancel(): void;
  evalExpression(expr: string, field?: "length" | "angle"): { ok: true; value: number } | { ok: false; error: { code: string; message: string } };
  defineParam(name: string, unit: "mm" | "deg", value: string): { ok: true; value: number } | { ok: false; error: { code: string; message: string } };
  finish(): FinishResult;
  feature(): v1.SketchFeature;
  dispose(): void;
}

export interface SketchEngineFactory {
  ready(): Promise<void>;
  load(req: SketchLoadRequest): SketchEngine;
}

export interface SketchPlaneChoice {
  /** The IR plane reference the feature stores. */
  ref: v1.PlaneRef;
  /** Its frame (for display and for projecting the model). */
  frame: Frame3;
  label: string;
}

export interface BeginOptions {
  plane: SketchPlaneChoice;
  /** Edit this existing sketch (else a new one). */
  sketch?: v1.SketchFeature;
  /** A new sketch's id and name (default: the first free `sketch<n>`, see `names.ts`). */
  id?: string;
  name?: string;
  /** The IR v1 document: its parameters are usable in dimensions, its names are taken. */
  document?: v1.IrDocument;
  part?: string;
  after?: string | null;
  /** Ids and names the document already uses, beyond `document`'s (e.g. an IR v0 document's). */
  taken?: readonly string[];
  context?: ContextGeometry;
}

export interface Notice {
  kind: "info" | "warning" | "error";
  text: string;
  /** A one-click repair: remove this constraint, or make the pending dimension driven. */
  action?: { label: string; run: "removeConstraint" | "makeDriven"; arg?: string };
}

export interface DimEdit {
  mode: "new" | "edit";
  /** Existing dimension (edit). */
  id: string | null;
  proposal: DimProposal | null;
  at: P2;
  text: string;
  field: "length" | "angle";
  error: string | null;
  /** The value over-constrains: offer "make driven". */
  conflict: boolean;
}

export interface TypedInput {
  label: string;
  text: string;
  error: string | null;
}

export interface SketchModeState {
  phase: "off" | "choosePlane" | "loading" | "active";
  plane: SketchPlaneChoice | null;
  sketchId: string;
  sketchName: string;
  mode: "new" | "edit";
  snapshot: SketchSnapshot | null;
  feature: v1.SketchFeature | null;
  /** Geometry during a drag (the snapshot's until the drag ends). */
  live: LiteralCurve[] | null;
  tool: ToolId;
  construction: boolean;
  selection: SketchSel[];
  hover: SketchSel | null;
  preview: ToolPreview;
  /** The dimension tool's pending dimension at the cursor. */
  pendingDim: { proposal: DimProposal; at: P2 } | null;
  view: ViewState;
  dimEdit: DimEdit | null;
  typed: TypedInput | null;
  notice: Notice | null;
  /** Dimension label positions (UI state until SPEC set A stores them). */
  labels: Record<string, P2>;
  gridSnap: boolean;
  context: ContextGeometry;
  /** A fatal load error (no WASM, bad sketch). */
  error: string | null;
  /** The last finished sketch (the harness and e2e read it). */
  finished: SketchFinish | null;
  hint: string;
  /** Pending defaults for a new sketch (from requestNew). */
  pending: Omit<BeginOptions, "plane"> | null;
}

const HIT_PX = 7;
const SNAP_PX = 10;

function initialState(): SketchModeState {
  return {
    phase: "off",
    plane: null,
    sketchId: "",
    sketchName: "",
    mode: "new",
    snapshot: null,
    feature: null,
    live: null,
    tool: "select",
    construction: false,
    selection: [],
    hover: null,
    preview: EMPTY_PREVIEW,
    pendingDim: null,
    view: initialView(800, 600),
    dimEdit: null,
    typed: null,
    notice: null,
    labels: {},
    gridSnap: false,
    context: EMPTY_CONTEXT,
    error: null,
    finished: null,
    hint: "",
    pending: null,
  };
}

export interface KeyIn {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** The event target is a text field. */
  editable: boolean;
}

export interface WheelIn {
  px: P2;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/** Human text for a rejected edit. */
export function explainRejection(r: Extract<ApplyResult, { ok: false }>): Notice {
  const e = r.error;
  const c = r.candidate;
  switch (e.code) {
    case "SKETCH_CONSTRAINT_CONFLICT": {
      const set = c?.conflicts[0];
      if (set) {
        const others = set.constraints.filter((x) => x !== set.suggestedRemoval);
        return { kind: "error", text: `That over-constrains the sketch: it conflicts with ${others.join(", ") || "the existing constraints"}.` };
      }
      return { kind: "error", text: "That over-constrains the sketch." };
    }
    case "SESSION_REDUNDANT":
      return { kind: "warning", text: `Already constrained: ${e.message.replace(/^already implied: /, "")}` };
    case "SKETCH_SOLVE_FAILED":
      return { kind: "error", text: "The solver cannot satisfy that: nothing changed." };
    case "DEGENERATE_CURVE":
      return { kind: "error", text: `That would collapse a curve (${String(e.details?.["curve"] ?? "")}).` };
    case "SKETCH_INVALID_DIMENSION":
      return { kind: "error", text: "A length must be greater than zero." };
    case "SESSION_UNSOLVED":
      return { kind: "error", text: "Fix the conflict before dragging." };
    default:
      return { kind: "error", text: e.message };
  }
}

export class SketchMode extends Store<SketchModeState> {
  private engines: SketchEngineFactory | null;
  private sink: SketchCommitSink;
  private engine: SketchEngine | null = null;
  private tool: SketchTool = createTool("select");
  private panning: { px: P2 } | null = null;
  private spaceDown = false;
  private dragTarget: string | null = null;
  private after: string | null = null;
  private part: string | null = null;
  readonly memory = new MemorySink();

  constructor(engines: SketchEngineFactory | null = null, sink?: SketchCommitSink) {
    super(initialState());
    this.engines = engines;
    this.sink = sink ?? this.memory;
  }

  /** Install the engine factory (the WASM session) — lazily, so the app starts without it. */
  setEngines(f: SketchEngineFactory): void {
    this.engines = f;
  }

  /** Route finished sketches into the command layer (integrator; default: memory). */
  setSink(sink: SketchCommitSink): void {
    this.sink = sink;
  }

  /** No command-layer sink is installed yet: finished sketches stay in memory. */
  get usingMemorySink(): boolean {
    return this.sink === this.memory;
  }

  get active(): boolean {
    return this.getState().phase === "active";
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────────

  /** Start a new sketch: ask for the plane (origin planes, or the selected planar face). */
  requestNew(defaults: Omit<BeginOptions, "plane"> = {}): void {
    if (this.getState().phase === "active") return;
    this.setState({ phase: "choosePlane", pending: defaults, error: null, notice: null });
  }

  /** Close the plane picker without sketching. */
  dismissPlanePicker(): void {
    if (this.getState().phase === "choosePlane") this.setState({ phase: "off", pending: null });
  }

  /** Enter sketch mode on a plane (a new sketch, or `opts.sketch` to edit one). */
  async begin(opts: BeginOptions): Promise<boolean> {
    if (!this.engines) {
      this.setState({ phase: "off", error: "The sketch engine is not available in this build." });
      return false;
    }
    const pending = this.getState().pending ?? {};
    const o: BeginOptions = { ...pending, ...opts };
    this.setState({ phase: "loading", plane: o.plane, error: null, notice: null });
    try {
      await this.engines.ready();
    } catch (e) {
      this.setState({ phase: "off", error: `The sketch engine did not load: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
    const id = o.sketch?.id ?? o.id ?? nextSketchName([...namesIn(o.document), ...(o.taken ?? [])]);
    const name = o.sketch?.name ?? o.name ?? id;
    const sketch = o.sketch ?? ({ type: "sketch", id, name, plane: o.plane.ref, curves: [] } as v1.SketchFeature);
    let engine: SketchEngine;
    try {
      engine = this.engines.load({ sketch, ...(o.document ? { document: o.document } : {}), ...(o.part ? { part: o.part } : {}) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState({ phase: "off", error: `This sketch cannot be edited here: ${msg}` });
      return false;
    }
    this.engine?.dispose();
    this.engine = engine;
    this.after = o.after ?? null;
    this.part = o.part ?? null;
    this.tool = createTool("line");
    const snapshot = engine.snapshot();
    const view = this.getState().view;
    const box = bounds(snapshot.curves);
    this.setState({
      phase: "active",
      sketchId: id,
      sketchName: name,
      mode: o.sketch ? "edit" : "new",
      snapshot,
      feature: engine.feature(),
      live: null,
      tool: "line",
      selection: [],
      hover: null,
      preview: EMPTY_PREVIEW,
      pendingDim: null,
      dimEdit: null,
      typed: null,
      labels: {},
      context: o.context ?? EMPTY_CONTEXT,
      finished: null,
      pending: null,
      view: box ? fitBox(view, box) : { ...view, cx: 0, cy: 0 },
      hint: this.tool.hint(),
      notice:
        o.sketch && (o.sketch.constraints ?? []).length === 0 && snapshot.constraints.length > 0
          ? { kind: "info", text: "Converted to a constrained sketch: its sizes are now dimensions bound to the same parameters." }
          : null,
    });
    return true;
  }

  /**
   * Finish: evaluate and validate the feature, hand it to the sink, leave sketch mode. A sketch
   * that would fail (a conflict, an open profile) is kept open with the reason, unless `force`.
   */
  async finish(opts: { force?: boolean } = {}): Promise<SketchFinish | null> {
    const s = this.getState();
    if (s.phase !== "active" || !this.engine) return null;
    const r = this.engine.finish();
    if (!r.ok && !opts.force) {
      const why = r.error ? r.error.message : r.validation.map((v) => v.message).join("; ");
      this.setState({ notice: { kind: "error", text: `The sketch would fail: ${why}. Fix it, or Finish anyway.` } });
      return null;
    }
    const f: SketchFinish = {
      mode: s.mode,
      feature: r.feature,
      after: this.after,
      part: this.part,
      params: r.params,
      edits: r.edits,
      conversion: r.conversion ?? null,
      check: { ok: r.ok, ...(r.error ? { error: r.error } : {}), regions: r.regions, ...(r.status ? { status: r.status } : {}), ...(r.dof !== undefined ? { dof: r.dof } : {}), warnings: r.warnings, validation: r.validation },
    };
    const out = await this.sink.commit(f);
    if (!out.ok) {
      this.setState({ notice: { kind: "error", text: `The model did not accept the sketch: ${out.message}` } });
      return null;
    }
    this.close({ finished: f });
    return f;
  }

  /** Leave sketch mode without committing anything. */
  cancel(): void {
    const s = this.getState();
    if (s.phase === "choosePlane") return this.dismissPlanePicker();
    if (s.phase !== "active" && s.phase !== "loading") return;
    this.close({ finished: null });
  }

  private close(extra: Partial<SketchModeState>): void {
    this.engine?.dispose();
    this.engine = null;
    this.dragTarget = null;
    this.setState({ ...initialState(), view: this.getState().view, gridSnap: this.getState().gridSnap, ...extra });
  }

  // ── Tools ────────────────────────────────────────────────────────────────────────────────

  setTool(id: ToolId): void {
    if (!this.active) return;
    this.tool = createTool(id);
    this.setState({ tool: id, preview: EMPTY_PREVIEW, pendingDim: null, typed: null, hint: this.tool.hint() });
  }

  toggleConstruction(): void {
    const s = this.getState();
    if (!this.active) return;
    const curves = s.selection.filter((x): x is { kind: "curve"; id: string } => x.kind === "curve");
    if (curves.length === 0) {
      this.setState({ construction: !s.construction, notice: { kind: "info", text: !s.construction ? "New curves are construction geometry." : "New curves are profile geometry." } });
      return;
    }
    const edits: SketchEdit[] = curves.map(({ id }) => {
      const c = this.curves().find((x) => x.id === id);
      return { op: "setConstruction", id, construction: !c?.construction };
    });
    this.applyEdits(edits);
  }

  toggleGrid(): void {
    this.setState({ gridSnap: !this.getState().gridSnap });
  }

  /** Add a constraint of `kind` to the selection (palette buttons, H/V keys). */
  constrain(kind: ConstraintKind): boolean {
    const s = this.getState();
    if (!this.active) return false;
    const plan = constraintsFor(kind, s.selection, this.curves(), IdAllocator.of(s.snapshot, s.feature));
    if (!plan.ok) {
      this.setState({ notice: { kind: "info", text: plan.reason } });
      return false;
    }
    const opts: ApplyOptions = kind === "fix" ? { allowRedundant: true } : {};
    return this.applyEdits(plan.constraints.map((constraint): SketchEdit => ({ op: "addConstraint", constraint })), opts);
  }

  deleteSelection(): void {
    const s = this.getState();
    if (!this.active || s.selection.length === 0) return;
    const edits: SketchEdit[] = [];
    for (const x of s.selection) {
      if (x.kind === "constraint") edits.push({ op: "removeConstraint", id: x.id });
    }
    for (const x of s.selection) {
      if (x.kind === "curve") edits.push({ op: "removeCurve", id: x.id });
    }
    if (edits.length && this.applyEdits(edits)) this.setState({ selection: [] });
  }

  removeConstraint(id: string): void {
    this.applyEdits([{ op: "removeConstraint", id }]);
  }

  undo(): void {
    if (!this.engine || !this.active) return;
    this.engine.dragCancel();
    this.refresh(this.engine.undo());
  }

  redo(): void {
    if (!this.engine || !this.active) return;
    this.refresh(this.engine.redo());
  }

  // ── Dimensions ───────────────────────────────────────────────────────────────────────────

  openDimension(proposal: DimProposal, at: P2): void {
    this.setState({ dimEdit: { mode: "new", id: null, proposal, at, text: fmt(proposal.measured, proposal.field === "angle" ? 2 : 3), field: proposal.field, error: null, conflict: false } });
  }

  /** Open the inline editor on an existing dimension (double-click its label). */
  editDimension(id: string, at?: P2): void {
    const s = this.getState();
    const info = s.snapshot?.constraints.find((c) => c.id === id);
    const con = s.feature?.constraints?.find((c) => c.id === id);
    if (!info || !con || info.driving === undefined) return;
    const field = con.type === "angle" ? "angle" : "length";
    const text = info.expr ?? (info.value !== undefined ? fmt(info.value, 6) : info.measured !== undefined ? fmt(info.measured, 6) : "");
    this.setState({ dimEdit: { mode: "edit", id, proposal: null, at: at ?? s.labels[id] ?? [0, 0], text, field, error: null, conflict: false } });
  }

  setDimText(text: string): void {
    const d = this.getState().dimEdit;
    if (d) this.setState({ dimEdit: { ...d, text, error: null, conflict: false } });
  }

  cancelDimension(): void {
    this.setState({ dimEdit: null });
  }

  /**
   * Commit the inline editor: a number, an expression over the parameters, or `name = value`
   * (defines a parameter and binds the dimension to it).
   */
  commitDimension(): boolean {
    const s = this.getState();
    const d = s.dimEdit;
    if (!d || !this.engine) return false;
    const parsed = this.parseValue(d.text, d.field);
    if (!parsed.ok) {
      this.setState({ dimEdit: { ...d, error: parsed.error } });
      return false;
    }
    if (d.field === "length" && parsed.value <= 0) {
      this.setState({ dimEdit: { ...d, error: "A length must be greater than zero." } });
      return false;
    }
    let edits: SketchEdit[];
    let newId: string | null = null;
    if (d.mode === "new" && d.proposal) {
      const ids = IdAllocator.of(s.snapshot, s.feature);
      newId = ids.next(d.proposal.shape.type === "angle" ? "ang" : d.proposal.shape.type === "radius" ? "r" : d.proposal.shape.type === "diameter" ? "dia" : "d");
      edits = [{ op: "addConstraint", constraint: dimensionConstraint(d.proposal.shape, newId, parsed.scalar) }];
    } else if (d.mode === "edit" && d.id) {
      edits = [{ op: "setDimension", id: d.id, value: parsed.scalar }];
    } else {
      return false;
    }
    const r = this.engine.apply(edits);
    if (!r.ok) {
      const conflict = r.error.code === "SKETCH_CONSTRAINT_CONFLICT" || r.error.code === "SESSION_REDUNDANT" || r.error.code === "SKETCH_SOLVE_FAILED";
      this.setState({ dimEdit: { ...d, error: explainRejection(r).text, conflict } });
      return false;
    }
    this.refresh(r.snapshot);
    const labels = newId ? { ...this.getState().labels, [newId]: d.at } : this.getState().labels;
    this.setState({ dimEdit: null, labels });
    return true;
  }

  /** The pending or edited dimension becomes a reference (driven) dimension. */
  makeDriven(): boolean {
    const s = this.getState();
    const d = s.dimEdit;
    if (!d || !this.engine) return false;
    let edits: SketchEdit[];
    let newId: string | null = null;
    if (d.mode === "new" && d.proposal) {
      newId = IdAllocator.of(s.snapshot, s.feature).next("ref");
      edits = [{ op: "addConstraint", constraint: dimensionConstraint(d.proposal.shape, newId, null) }];
    } else if (d.id) {
      edits = [{ op: "setDimension", id: d.id, driving: false }];
    } else return false;
    const r = this.engine.apply(edits);
    if (!r.ok) {
      this.setState({ dimEdit: { ...d, error: explainRejection(r).text } });
      return false;
    }
    this.refresh(r.snapshot);
    this.setState({ dimEdit: null, labels: newId ? { ...this.getState().labels, [newId]: d.at } : this.getState().labels });
    return true;
  }

  /** Toggle a dimension between driving and driven. */
  toggleDriving(id: string): void {
    const info = this.getState().snapshot?.constraints.find((c) => c.id === id);
    if (!info || info.driving === undefined) return;
    this.applyEdits([{ op: "setDimension", id, driving: !info.driving }]);
  }

  moveLabel(id: string, at: P2): void {
    this.setState({ labels: { ...this.getState().labels, [id]: at } });
  }

  private parseValue(text: string, field: "length" | "angle"): { ok: true; value: number; scalar: v1.Scalar } | { ok: false; error: string } {
    const t = text.trim();
    if (!t) return { ok: false, error: "Type a value." };
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(t);
    if (assign) {
      const [, name, rhs] = assign as unknown as [string, string, string];
      if (!isId(name)) return { ok: false, error: "Not a valid parameter name." };
      const r = this.engine!.defineParam(name, field === "angle" ? "deg" : "mm", rhs.trim());
      if (!r.ok) return { ok: false, error: r.error.message };
      return { ok: true, value: r.value, scalar: name };
    }
    const num = Number(t);
    if (t !== "" && Number.isFinite(num) && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return { ok: true, value: num, scalar: num };
    const r = this.engine!.evalExpression(t, field);
    if (!r.ok) return { ok: false, error: r.error.message };
    return { ok: true, value: r.value, scalar: t };
  }

  // ── Typed values while drawing ───────────────────────────────────────────────────────────

  private startTyping(ch: string): boolean {
    const label = this.tool.typedLabel?.() ?? null;
    if (!label) return false;
    this.setState({ typed: { label, text: ch, error: null } });
    return true;
  }

  setTypedText(text: string): void {
    const t = this.getState().typed;
    if (t) this.setState({ typed: { ...t, text, error: null } });
  }

  commitTyped(): boolean {
    const t = this.getState().typed;
    if (!t || !this.engine) return false;
    const r = this.parseValue(t.text, "length");
    if (!r.ok) {
      this.setState({ typed: { ...t, error: r.error } });
      return false;
    }
    const api = this.api();
    const done = this.tool.typed?.(r.value, t.text, api) ?? false;
    this.setState({ typed: done ? null : { ...t, error: "That value does not apply here." } });
    this.syncTool();
    return done;
  }

  cancelTyped(): void {
    this.setState({ typed: null });
  }

  // ── View ─────────────────────────────────────────────────────────────────────────────────

  setViewport(width: number, height: number): void {
    const v = this.getState().view;
    if (v.width === width && v.height === height) return;
    this.setState({ view: { ...v, width, height } });
  }

  fit(): void {
    const s = this.getState();
    const all = [...(s.live ?? s.snapshot?.curves ?? [])];
    const box = bounds(all);
    this.setState({ view: fitBox(s.view, box) });
  }

  wheel(e: WheelIn): void {
    const s = this.getState();
    if (isTrackpadPan(e)) {
      this.setState({ view: pan(s.view, -e.deltaX, -e.deltaY) });
      return;
    }
    const k = e.ctrlKey ? 0.01 : 0.0015;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.setState({ view: zoomAt(s.view, e.px, Math.exp(-dy * k)) });
  }

  // ── Pointer ──────────────────────────────────────────────────────────────────────────────

  private toSketch(px: P2): P2 {
    return new PlaneView(this.getState().view).toSketch(px);
  }

  pointerDown(e: PointerIn): void {
    if (!this.active) return;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      this.panning = { px: e.px };
      return;
    }
    if (this.getState().dimEdit) this.commitDimension();
    this.tool.down(this.toSketch(e.px), e, this.api());
    this.syncTool();
  }

  pointerMove(e: PointerIn): void {
    if (!this.active) return;
    if (this.panning) {
      const s = this.getState();
      this.setState({ view: pan(s.view, e.px[0] - this.panning.px[0], e.px[1] - this.panning.px[1]) });
      this.panning = { px: e.px };
      return;
    }
    const p = this.toSketch(e.px);
    this.tool.move(p, e, this.api());
    const hover = this.tool.id === "select" || this.tool.id === "dimension" ? this.hitSel(p) : null;
    const cur = this.getState().hover;
    if (JSON.stringify(cur) !== JSON.stringify(hover)) this.setState({ hover });
    this.syncTool();
  }

  pointerUp(e: PointerIn): void {
    if (!this.active) return;
    if (this.panning) {
      this.panning = null;
      return;
    }
    this.tool.up(this.toSketch(e.px), e, this.api());
    this.syncTool();
  }

  private syncTool(): void {
    const pendingDim = this.tool instanceof DimensionTool ? this.tool.pending() : null;
    this.setState({ preview: this.tool.preview(), pendingDim, hint: this.tool.hint() });
  }

  // ── Keys ─────────────────────────────────────────────────────────────────────────────────

  /** A key in sketch mode; returns whether sketch mode consumed it. */
  key(e: KeyIn): boolean {
    const s = this.getState();
    if (s.phase === "choosePlane") {
      if (e.key === "Escape") {
        this.dismissPlanePicker();
        return true;
      }
      return false;
    }
    if (!this.active) return false;
    const k = e.key;
    if (k === " ") {
      this.spaceDown = true;
      return !e.editable;
    }
    if (s.dimEdit) {
      if (k === "Escape") return this.cancelDimension(), true;
      if (k === "Enter") return this.commitDimension(), true;
      return false;
    }
    if (s.typed) {
      if (k === "Escape") return this.cancelTyped(), true;
      if (k === "Enter") return this.commitTyped(), true;
      if (e.editable) return false;
    }
    if (e.editable) return false;
    if (e.mod && k.toLowerCase() === "z") {
      if (e.shift) this.redo();
      else this.undo();
      return true;
    }
    if (e.mod && k.toLowerCase() === "y") return this.redo(), true;
    if (e.mod) return false;
    switch (k) {
      case "Escape": {
        const api = this.api();
        if (this.tool.escape(api)) {
          this.syncTool();
          return true;
        }
        if (this.tool.id !== "select") {
          this.setTool("select");
          return true;
        }
        if (s.selection.length) {
          this.setState({ selection: [] });
          return true;
        }
        void this.finish();
        return true;
      }
      case "Enter":
        if (this.tool.enter?.(this.api())) {
          this.syncTool();
          return true;
        }
        return false;
      case "Delete":
      case "Backspace":
        this.deleteSelection();
        return true;
    }
    if (/^[0-9.]$/.test(k) || (k === "-" && this.tool.typedLabel?.())) return this.startTyping(k);
    const lower = k.toLowerCase();
    if (e.shift || e.alt) return false;
    if (lower === "x") return this.toggleConstruction(), true;
    if (lower === "h") return this.constrain("horizontal"), true;
    if (lower === "v") return this.constrain("vertical"), true;
    if (lower === "f") return this.fit(), true;
    if (lower === "g") return this.toggleGrid(), true;
    if (lower === "s") return this.setTool("select"), true;
    const t = SKETCH_TOOLS.find((x) => x.key === lower);
    if (t) {
      this.setTool(t.id);
      return true;
    }
    return false;
  }

  keyUp(key: string): void {
    if (key === " ") this.spaceDown = false;
  }

  // ── Hit testing ──────────────────────────────────────────────────────────────────────────

  curves(): readonly LiteralCurve[] {
    const s = this.getState();
    return s.live ?? s.snapshot?.curves ?? [];
  }

  private mmPerPx(): number {
    return 1 / this.getState().view.scale;
  }

  hitPoint(p: P2): { ref: string; point: P2 } | null {
    const tol = HIT_PX * this.mmPerPx();
    let best: { ref: string; point: P2; d: number } | null = null;
    for (const c of this.curves()) {
      const refs: Array<[string, string]> =
        c.kind === "point" ? [[c.id, "at"]] : c.kind === "line" ? [[`${c.id}.start`, "start"], [`${c.id}.end`, "end"]] : c.kind === "arc" ? [[`${c.id}.start`, "start"], [`${c.id}.end`, "end"], [`${c.id}.center`, "center"]] : [[`${c.id}.center`, "center"]];
      for (const [ref, which] of refs) {
        const q = curvePoint(c, which)!;
        const d = dist(p, q);
        if (d <= tol && (!best || d < best.d - 1e-12)) best = { ref, point: q, d };
      }
    }
    return best ? { ref: best.ref, point: best.point } : null;
  }

  hitCurve(p: P2): LiteralCurve | null {
    const tol = HIT_PX * this.mmPerPx();
    let best: { c: LiteralCurve; d: number } | null = null;
    for (const c of this.curves()) {
      const d = nearestOnCurve(c, p).distance;
      if (d <= tol && (!best || d < best.d - 1e-12)) best = { c, d };
    }
    return best?.c ?? null;
  }

  private hitSel(p: P2): SketchSel | null {
    const pt = this.hitPoint(p);
    if (pt) return { kind: "point", ref: pt.ref };
    const c = this.hitCurve(p);
    return c ? { kind: "curve", id: c.id } : null;
  }

  // ── Selection (from the UI: glyphs, the constraint list) ─────────────────────────────────

  select(sel: SketchSel[], add = false): void {
    const cur = this.getState().selection;
    const key = (x: SketchSel): string => JSON.stringify(x);
    if (!add) {
      this.setState({ selection: sel });
      return;
    }
    const keys = new Set(cur.map(key));
    const toggled = [...cur.filter((x) => !sel.some((y) => key(y) === key(x))), ...sel.filter((x) => !keys.has(key(x)))];
    this.setState({ selection: toggled });
  }

  // ── Edits ────────────────────────────────────────────────────────────────────────────────

  private refresh(snapshot: SketchSnapshot): void {
    const feature = this.engine?.feature() ?? null;
    const ids = new Set(snapshot.curves.map((c) => c.id));
    const cons = new Set(snapshot.constraints.map((c) => c.id));
    const selection = this.getState().selection.filter((x) => (x.kind === "curve" ? ids.has(x.id) : x.kind === "constraint" ? cons.has(x.id) : ids.has(x.ref.includes(".") ? x.ref.slice(0, x.ref.lastIndexOf(".")) : x.ref)));
    const labels = Object.fromEntries(Object.entries(this.getState().labels).filter(([k]) => cons.has(k)));
    this.setState({ snapshot, feature, live: null, selection, labels });
  }

  /** Apply edits from a UI action; reports a rejection as a notice. */
  applyEdits(edits: SketchEdit[], opts: ApplyOptions = {}): boolean {
    if (!this.engine) return false;
    const r = this.engine.apply(edits, opts);
    if (!r.ok) {
      this.setState({ notice: explainRejection(r) });
      return false;
    }
    this.refresh(r.snapshot);
    return true;
  }

  private commitGesture(core: SketchEdit[], auto: SketchEdit[], opts: ApplyOptions = {}): ApplyResult {
    const engine = this.engine!;
    let r = engine.apply([...core, ...auto], { dropRedundant: true, ...opts });
    if (!r.ok && auto.length > 0) {
      const again = engine.apply(core, { dropRedundant: true, ...opts });
      if (again.ok) this.setState({ notice: { kind: "info", text: "Auto-constraints were skipped: they would over-constrain the sketch." } });
      r = again;
    }
    if (!r.ok) this.setState({ notice: explainRejection(r) });
    else this.refresh(r.snapshot);
    return r;
  }

  private api(): ToolApi {
    const self = this;
    return {
      curves: () => self.curves(),
      feature: () => self.getState().feature ?? ({ type: "sketch", id: "", name: "", plane: "XY", curves: [] } as v1.SketchFeature),
      snapshot: () => self.getState().snapshot!,
      tol: () => SNAP_PX * self.mmPerPx(),
      mmPerPx: () => self.mmPerPx(),
      snap: (p: P2, e: PointerIn, o: SnapOptions = {}) => {
        const s = self.getState();
        return snap(p, {
          curves: self.curves(),
          tol: SNAP_PX * self.mmPerPx(),
          anchor: o.anchor ?? null,
          tangent: o.tangent ?? null,
          ...(o.excludeRefs ? { excludeRefs: o.excludeRefs } : {}),
          ...(o.excludeCurves ? { excludeCurves: o.excludeCurves } : {}),
          modelPoints: s.context.points,
          grid: s.gridSnap ? gridFor(s.view.scale) : null,
          disabled: e.alt,
        });
      },
      hitCurve: (p) => self.hitCurve(p),
      hitPoint: (p) => self.hitPoint(p),
      ids: () => IdAllocator.of(self.getState().snapshot, self.getState().feature),
      construction: () => self.getState().construction,
      commit: (core, auto = [], opts = {}) => self.commitGesture(core, auto, opts),
      notify: (kind, text) => self.setState({ notice: { kind, text } }),
      selection: () => self.getState().selection,
      setSelection: (sel) => self.setState({ selection: sel }),
      openDimension: (p, at) => self.openDimension(p, at),
      dragBegin: (target, grab, mode) => {
        const r = self.engine!.dragBegin({ target, grab, ...(mode ? { mode } : {}) });
        if (!r.ok) {
          self.setState({ notice: { kind: "warning", text: r.error.code === "SESSION_UNSOLVED" ? "Fix the conflict before dragging." : r.error.message } });
          return false;
        }
        self.dragTarget = target;
        return true;
      },
      dragTo: (p) => {
        const r = self.engine!.dragTo(p[0], p[1]);
        if (r.ok) self.setState({ live: r.frame.curves });
      },
      dragEnd: () => {
        self.dragTarget = null;
        const r = self.engine!.dragEnd();
        if (!r.ok) {
          self.setState({ live: null, notice: explainRejection(r) });
          return;
        }
        self.refresh(r.snapshot);
      },
      dragCancel: () => {
        self.dragTarget = null;
        self.engine!.dragCancel();
        self.setState({ live: null });
      },
    };
  }

  /** The label of the current tool (status bar). */
  toolLabel(): string {
    return toolInfo(this.getState().tool).label;
  }

  /** Where a point reference is now (tests, glyph placement). */
  pointOf(ref: string): P2 | null {
    return refPoint(this.curves(), ref);
  }
}

function gridFor(scale: number): number {
  const raw = 12 / scale;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (p * m >= raw) return p * m;
  return p * 10;
}

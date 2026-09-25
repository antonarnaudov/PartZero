/**
 * The DocStore: the open document as the UI sees it — its content, the model the timeline shows,
 * the evaluation report and display bodies, plus selection and undo/redo.
 *
 * Two kinds of documents:
 * - **IR v1 documents** (`format: "ir-v1"`, the app's document model for new documents and every
 *   `.partzero` it writes): the document of record is the {@link IrDocStore} (`deps.ir`), edited
 *   only through the command layer's ops (FULL-MODELING-PLAN §2.1). This store mirrors it: `source`
 *   is its canonical IR text, `v1.host` its rollback marker and appearance, `history` its undo
 *   stack; undo/redo go to it. Every change schedules an evaluation of the document cut at the
 *   rollback marker (features after it are not built), with the appearance applied to the bodies.
 *   The code view is read-only (it is hidden by default: View ▸ Show Code).
 * - **CadScript documents** (`cadscript`, `ir-json`; IR v0, kept for hosts without the IR v1
 *   engine): every change is a transaction on the **source** (recorded with its inverse; see
 *   `history.ts`), then compile + type-check (debounced while typing) → evaluate when the IR
 *   changed.
 *
 * Results of superseded runs are dropped (revision check), so the state always describes the
 * latest content.
 */
import type { EvalReport, IrDocument } from "@aicad/ir-types";
import { EMPTY_HOST_STATE, hostStateEqual, rolledBack, type Approvals, type HostState } from "@aicad/model-ops";
import type { CadScriptService, CompileOutput } from "../cadscript/service";
import type { ForgeEngine, PickResult, RenderBody } from "../engine/types";
import { Store } from "../store";
import { History, type TransactionOrigin } from "./history";
import { featureNameOfBody } from "./provenance";
import type { IrDocStore } from "./v1/ir-doc-store";
import { namesAsIds } from "./v1/names-as-ids";

export type DocFormat = "cadscript" | "ir-json" | "ir-v1";

export type SelectionOrigin = "timeline" | "viewport" | "code" | "command" | "agent";

export interface Selection {
  /** Selected feature id (the IR id; stable across recompiles). */
  featureId: string | null;
  /** The picked viewport entity, when the selection came from the viewport. */
  entity: PickResult | null;
  origin: SelectionOrigin | null;
}

export type PipelinePhase = "idle" | "pending" | "compiling" | "evaluating";

export interface DocState {
  /** Increments whenever another document is loaded. */
  docId: number;
  path: string | null;
  name: string;
  format: DocFormat;
  /** The CadScript source; for an IR v1 document, its canonical IR text. */
  source: string;
  /** Source as last saved (or as loaded). */
  savedSource: string;
  dirty: boolean;
  /** Increments on every source change. */
  revision: number;
  /** Compile output for `source` at `compiledRevision` (may contain errors). */
  compile: CompileOutput | null;
  compiledRevision: number;
  /** The last *successful* compile: drives the timeline and evaluation while the code has errors. */
  model: CompileOutput | null;
  report: EvalReport | null;
  bodies: readonly RenderBody[];
  /** The IR JSON that `report`/`bodies` were evaluated from. */
  evaluatedIrJson: string | null;
  phase: PipelinePhase;
  engineError: string | null;
  timings: { compileMs: number | null; evalMs: number | null };
  selection: Selection;
  history: { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };
  /** IR v1 documents: the host state (rollback marker, appearance) and what the file holds (see {@link v1ContentKey}). */
  v1: { host: HostState; savedKey: string } | null;
}

export interface DocDescriptor {
  path: string | null;
  name: string;
  format: DocFormat;
  /** CadScript source, or (`ir-v1`) IR JSON text of either version (a v0 document is migrated). */
  source: string;
  /** The IR the source was printed from (IR JSON files): its part/feature ids are kept on compile. */
  baseIr?: IrDocument;
  /** `ir-v1`: the rollback marker and appearance saved with the document. */
  host?: HostState;
  /** `ir-v1`: load `source` as unsaved changes over this saved content (recovery). */
  savedV1?: { source: string; host?: HostState };
}

export interface SetSourceOptions {
  label?: string;
  origin?: TransactionOrigin;
  /** Typing: merge with the previous edit of the same key, and debounce the recompile. */
  coalesceKey?: string;
}

export interface DocStoreDeps {
  cadscript: CadScriptService;
  /** The current engine (the engine manager can swap it at runtime). */
  engine: () => ForgeEngine;
  /** The IR v1 document store (the document of record of `ir-v1` documents). */
  ir?: IrDocStore;
  /** Recompile delay after a coalesced (typing) edit, ms. Default 250. */
  debounceMs?: number;
  historyLimit?: number;
  coalesceMs?: number;
  now?: () => number;
}

const EMPTY_SELECTION: Selection = { featureId: null, entity: null, origin: null };
const NO_HISTORY: DocState["history"] = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };

/** What an IR v1 document's file holds: its canonical text and its host state (dirty = this differs from the saved key). */
export function v1ContentKey(source: string, host: HostState): string {
  return hostStateEqual(host, EMPTY_HOST_STATE) ? source : `${source}\n\u0001${JSON.stringify({ rollback: host.rollback, appearance: host.appearance })}`;
}

/** `#rrggbb` → sRGB 0..1. */
function rgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : null;
}

/** Colour the bodies whose origin feature has an appearance (feature ids → the names bodies carry). */
function applyAppearance(bodies: readonly RenderBody[], ir: IrDocument, appearance: Readonly<Record<string, string>>): RenderBody[] {
  const entries = Object.entries(appearance);
  if (entries.length === 0) return [...bodies];
  const byName = new Map<string, [number, number, number]>();
  for (const p of ir.parts) {
    for (const f of p.features) {
      const hex = appearance[f.id];
      const c = hex ? rgb(hex) : null;
      if (c) byName.set(f.name, c);
    }
  }
  return bodies.map((b) => {
    const c = byName.get(featureNameOfBody(b.name));
    return c ? { ...b, color: c } : b;
  });
}

export class DocStore extends Store<DocState> {
  private readonly deps: DocStoreDeps;
  private readonly history: History;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private forceEval = false;
  private disposed = false;
  /** Id base for the first compile after a load (until a compile succeeds). */
  private loadBase: IrDocument | null = null;
  /** An IR v1 document being loaded into the IR store (the store's changes are ignored until it lands). */
  private pendingV1: Promise<void> | null = null;

  constructor(deps: DocStoreDeps, initial?: DocDescriptor) {
    const doc = initial ?? { path: null, name: "Untitled", format: "cadscript" as const, source: "" };
    super({
      docId: 1,
      path: doc.path,
      name: doc.name,
      format: doc.format,
      source: doc.source,
      savedSource: doc.source,
      dirty: false,
      revision: 1,
      compile: null,
      compiledRevision: 0,
      model: null,
      report: null,
      bodies: [],
      evaluatedIrJson: null,
      phase: "idle",
      engineError: null,
      timings: { compileMs: null, evalMs: null },
      selection: EMPTY_SELECTION,
      history: NO_HISTORY,
      v1: null,
    });
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? 250;
    this.now = deps.now ?? (() => Date.now());
    this.history = new History({
      ...(deps.historyLimit !== undefined ? { limit: deps.historyLimit } : {}),
      ...(deps.coalesceMs !== undefined ? { coalesceMs: deps.coalesceMs } : {}),
    });
    this.loadBase = initial?.baseIr ?? null;
    deps.ir?.subscribe(() => this.onIrChange());
    if (initial) {
      if (initial.format === "ir-v1") this.load(initial);
      else this.schedule(0);
    }
  }

  /** Whether the open document is an IR v1 document (edited through the command layer). */
  get isV1(): boolean {
    return this.getState().format === "ir-v1";
  }

  /** Whether this app can hold IR v1 documents: it has the IR v1 store and an engine with the command layer. */
  get v1Available(): boolean {
    return this.deps.ir !== undefined && this.deps.engine().commands !== undefined;
  }

  /** Replace the document (open, new, template). Clears history and selection. */
  load(doc: DocDescriptor): void {
    if (doc.format === "ir-v1") {
      this.loadV1(doc);
      return;
    }
    this.pendingV1 = null;
    this.history.clear();
    this.loadBase = doc.baseIr ?? null;
    const s = this.getState();
    this.setState({
      docId: s.docId + 1,
      path: doc.path,
      name: doc.name,
      format: doc.format,
      source: doc.source,
      savedSource: doc.source,
      dirty: false,
      revision: s.revision + 1,
      compile: null,
      compiledRevision: 0,
      model: null,
      report: null,
      bodies: [],
      evaluatedIrJson: null,
      engineError: null,
      timings: { compileMs: null, evalMs: null },
      selection: EMPTY_SELECTION,
      history: this.historyState(),
      v1: null,
    });
    this.schedule(0);
  }

  private loadV1(doc: DocDescriptor): void {
    const ir = this.deps.ir;
    const s = this.getState();
    const docId = s.docId + 1;
    const host = doc.host ?? EMPTY_HOST_STATE;
    this.history.clear();
    this.loadBase = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setState({
      docId,
      path: doc.path,
      name: doc.name,
      format: "ir-v1",
      source: doc.source,
      savedSource: doc.source,
      dirty: false,
      revision: s.revision + 1,
      compile: null,
      compiledRevision: 0,
      model: null,
      report: null,
      bodies: [],
      evaluatedIrJson: null,
      engineError: null,
      phase: "pending",
      timings: { compileMs: null, evalMs: null },
      selection: EMPTY_SELECTION,
      history: NO_HISTORY,
      v1: { host, savedKey: v1ContentKey(doc.source, host) },
    });
    if (!ir) {
      this.setState({ phase: "idle", engineError: "This build has no IR v1 document store: the model cannot be opened." });
      return;
    }
    const pending = (async () => {
      let saved: { key: string } | null = null;
      if (doc.savedV1) {
        // Recovery: what the file holds, canonicalized, is the saved state; the recovered text is unsaved.
        const savedHost = doc.savedV1.host ?? EMPTY_HOST_STATE;
        const c = await ir.load(doc.savedV1.source, { host: savedHost });
        saved = { key: v1ContentKey(c.document, savedHost) };
      }
      const m = await ir.load(doc.source, { host });
      if (this.getState().docId !== docId) return;
      const key = v1ContentKey(m.document, host);
      const savedKey = saved?.key ?? key;
      this.setState((st) => ({
        source: m.document,
        savedSource: saved ? st.savedSource : m.document,
        v1: { host, savedKey },
        dirty: key !== savedKey,
        revision: st.revision + 1,
        history: ir.getState().history,
      }));
    })();
    this.pendingV1 = pending.then(
      () => {
        if (this.getState().docId !== docId) return;
        this.pendingV1 = null;
        this.schedule(0);
      },
      (e: unknown) => {
        if (this.getState().docId !== docId) return;
        this.pendingV1 = null;
        this.setState({ phase: "idle", engineError: `The model could not be opened: ${errorMessage(e)}` });
      },
    );
  }

  /** The IR v1 store changed (a command, undo, redo): mirror it and re-evaluate. */
  private onIrChange(): void {
    const s = this.getState();
    const ir = this.deps.ir;
    if (!ir || s.format !== "ir-v1" || this.pendingV1 || !s.v1) return;
    const irs = ir.getState();
    if (irs.document === null) return;
    const history = irs.history;
    const sameHistory =
      history.canUndo === s.history.canUndo && history.canRedo === s.history.canRedo && history.undoLabel === s.history.undoLabel && history.redoLabel === s.history.redoLabel;
    if (irs.document === s.source && hostStateEqual(irs.host, s.v1.host)) {
      if (!sameHistory) this.setState({ history });
      return;
    }
    const host = irs.host;
    this.setState((st) => ({
      source: irs.document!,
      v1: { host, savedKey: st.v1!.savedKey },
      dirty: v1ContentKey(irs.document!, host) !== st.v1!.savedKey,
      revision: st.revision + 1,
      history,
    }));
    this.schedule(0);
  }

  /**
   * Apply a source change as a transaction. Returns false when the source is unchanged, and for an
   * IR v1 document (edited through the command layer's ops, never as text).
   */
  setSource(source: string, options: SetSourceOptions = {}): boolean {
    if (this.isV1) return false;
    const before = this.getState().source;
    if (source === before) return false;
    this.history.record(before, source, {
      label: options.label ?? "Edit code",
      origin: options.origin ?? "user",
      coalesceKey: options.coalesceKey,
      time: this.now(),
    });
    this.applySource(source, options.coalesceKey !== undefined ? this.debounceMs : 0);
    return true;
  }

  /**
   * A code edit on an IR v1 model (FULL-MODELING-PLAN §2.1 rule 6): the CadScript (v1; a v0 source
   * compiles to its migration) becomes the document through the command layer's `replaceDocument`
   * op — one undoable transaction, authorship kept, the failure rule and ADR 0015's commit check
   * applied for `origin`. Throws when the code does not compile; resolves to whether the model
   * changed.
   */
  async applyCode(source: string, options: { label?: string; origin?: TransactionOrigin; approvals?: Approvals } = {}): Promise<boolean> {
    const ir = this.deps.ir;
    if (!ir || !this.isV1) throw new Error("applyCode edits IR v1 models; this document is CadScript (use setSource)");
    // CadScript v0 keeps its feature ids (the const names) through the migration; v1 compiles as v1.
    const v0 = await this.deps.cadscript.compile(source);
    if (v0.ok && v0.ir) return this.applyDocument(JSON.stringify(namesAsIds(v0.ir)), { label: "Edit code", ...options });
    const c = await this.deps.cadscript.compileV1(source);
    if (!c.ok || !c.irJson) {
      const first = c.errors[0];
      throw new Error(`The code does not compile${first ? ` (line ${first.line}: ${first.code} ${first.message})` : ""}.`);
    }
    return this.applyDocument(c.irJson, { label: "Edit code", ...options });
  }

  /** Replace an IR v1 model by `irJson` (either IR version) as one `replaceDocument` transaction; see {@link applyCode}. */
  async applyDocument(irJson: string, options: { label?: string; origin?: TransactionOrigin; approvals?: Approvals } = {}): Promise<boolean> {
    const ir = this.deps.ir;
    if (!ir || !this.isV1) throw new Error("applyDocument edits IR v1 models");
    const t = await ir.transaction(options.label ?? "Edit model", (tx) => tx.apply({ op: "replaceDocument", document: irJson }).then(() => undefined), {
      origin: options.origin ?? "user",
      ...(options.approvals ? { approvals: options.approvals } : {}),
    });
    await this.idle();
    return t.changed;
  }

  /** End the current (coalescing) transaction, e.g. when the editor loses focus. */
  sealTransaction(): void {
    this.history.seal();
  }

  undo(): boolean {
    if (this.isV1) return this.deps.ir?.undo() ?? false;
    const r = this.history.undo(this.getState().source);
    if (!r) return false;
    this.applySource(r.text, 0);
    return true;
  }

  redo(): boolean {
    if (this.isV1) return this.deps.ir?.redo() ?? false;
    const r = this.history.redo(this.getState().source);
    if (!r) return false;
    this.applySource(r.text, 0);
    return true;
  }

  /**
   * After a successful save: `savedSource` (default: the current content) is what the file holds. A save that captured
   * the content before an edit landed passes the captured content, so the document stays dirty with that edit. For an
   * IR v1 document the content is {@link v1ContentKey} (its text and host state).
   */
  markSaved(update: { path: string; name: string; format: DocFormat; savedSource?: string }): void {
    const { savedSource, ...rest } = update;
    this.setState((s) => {
      if (s.format === "ir-v1" && s.v1) {
        const now = v1ContentKey(s.source, s.v1.host);
        const saved = savedSource ?? now;
        return { ...rest, format: "ir-v1", savedSource: s.source, v1: { ...s.v1, savedKey: saved }, dirty: now !== saved };
      }
      const saved = savedSource ?? s.source;
      return { ...rest, savedSource: saved, dirty: s.source !== saved };
    });
  }

  select(selection: Partial<Selection> & { origin: SelectionOrigin }): void {
    this.setState({ selection: { ...EMPTY_SELECTION, ...selection } });
  }

  clearSelection(): void {
    this.setState({ selection: EMPTY_SELECTION });
  }

  /** Recompile and re-evaluate now, even when the IR did not change (e.g. after an engine switch). */
  recompute(): void {
    this.forceEval = true;
    this.schedule(0);
  }

  /** Resolves when the pipeline has settled for the current content (an IR v1 document: its store's ops too). */
  async idle(timeoutMs = 60_000): Promise<DocState> {
    const t0 = Date.now();
    for (;;) {
      if (this.pendingV1) await this.pendingV1;
      if (this.isV1) await this.deps.ir?.idle();
      const s = await this.waitFor((st) => st.phase === "idle" && this.timer === null, Math.max(1, timeoutMs - (Date.now() - t0)));
      // An op that landed while we waited moved the document on: wait for its evaluation too.
      if (!this.pendingV1 && (!this.isV1 || !this.deps.ir?.getState().busy)) return s;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ─── Pipeline ────────────────────────────────────────────────────────────────────────────

  private historyState(): DocState["history"] {
    return {
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      undoLabel: this.history.undoLabel,
      redoLabel: this.history.redoLabel,
    };
  }

  private applySource(source: string, delay: number): void {
    this.setState((s) => ({
      source,
      revision: s.revision + 1,
      dirty: source !== s.savedSource,
      history: this.historyState(),
    }));
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.setState({ phase: "pending" });
    this.timer = setTimeout(() => {
      this.timer = null;
      void (this.isV1 ? this.runV1() : this.run());
    }, delay);
  }

  private isStale(revision: number, docId: number): boolean {
    const s = this.getState();
    return this.disposed || s.revision !== revision || s.docId !== docId;
  }

  /** IR v1: the model is the document itself; evaluate it cut at the rollback marker, then colour its bodies. */
  private async runV1(): Promise<void> {
    const { revision, docId, source, v1 } = this.getState();
    const host = v1?.host ?? EMPTY_HOST_STATE;
    let ir: IrDocument;
    try {
      ir = JSON.parse(source) as IrDocument;
    } catch (e) {
      this.setState({ phase: "idle", engineError: `The model is not valid JSON: ${errorMessage(e)}` });
      return;
    }
    const compile: CompileOutput = { ok: true, ir, diagnostics: [], spans: {}, partSpans: {}, ms: 0 };
    this.setState({ compile, compiledRevision: revision, model: compile });
    const text = rolledBack(source, host.rollback);
    const key = `${text}\u0000${JSON.stringify(host.appearance)}`;
    const s = this.getState();
    if (!this.forceEval && key === s.evaluatedIrJson && (s.report !== null || s.engineError !== null)) {
      this.setState({ phase: "idle" });
      return;
    }
    this.forceEval = false;
    this.setState({ phase: "evaluating" });
    const t0 = performanceNow();
    try {
      const r = await this.deps.engine().evaluate(text);
      if (this.isStale(revision, docId)) return;
      this.setState((st) => ({
        report: r.report,
        bodies: applyAppearance(r.bodies, ir, host.appearance),
        evaluatedIrJson: key,
        engineError: null,
        phase: "idle",
        timings: { ...st.timings, evalMs: performanceNow() - t0 },
      }));
    } catch (e) {
      if (this.isStale(revision, docId)) return;
      this.setState((st) => ({
        report: null,
        bodies: [],
        evaluatedIrJson: key,
        engineError: errorMessage(e),
        phase: "idle",
        timings: { ...st.timings, evalMs: null },
      }));
    }
  }

  private async run(): Promise<void> {
    const { revision, docId, source, model } = this.getState();
    this.setState({ phase: "compiling" });
    let out: CompileOutput;
    try {
      out = await this.deps.cadscript.compile(source, model?.ir ?? this.loadBase);
    } catch (e) {
      if (this.isStale(revision, docId)) return;
      this.setState({ phase: "idle", engineError: `CadScript service failed: ${errorMessage(e)}` });
      return;
    }
    if (this.isStale(revision, docId)) return;
    if (out.ok) this.loadBase = null;
    this.setState((s) => ({
      compile: out,
      compiledRevision: revision,
      model: out.ok ? out : s.model,
      timings: { ...s.timings, compileMs: out.ms },
    }));
    if (!out.ok || !out.ir) {
      this.setState({ phase: "idle" });
      return;
    }

    const irJson = JSON.stringify(out.ir);
    const s = this.getState();
    if (!this.forceEval && irJson === s.evaluatedIrJson && (s.report !== null || s.engineError !== null)) {
      this.setState({ phase: "idle" });
      return;
    }
    this.forceEval = false;
    this.setState({ phase: "evaluating" });
    const t0 = performanceNow();
    try {
      const r = await this.deps.engine().evaluate(irJson);
      if (this.isStale(revision, docId)) return;
      this.setState((st) => ({
        report: r.report,
        bodies: r.bodies,
        evaluatedIrJson: irJson,
        engineError: null,
        phase: "idle",
        timings: { ...st.timings, evalMs: performanceNow() - t0 },
      }));
    } catch (e) {
      if (this.isStale(revision, docId)) return;
      this.setState((st) => ({
        report: null,
        bodies: [],
        evaluatedIrJson: irJson,
        engineError: errorMessage(e),
        phase: "idle",
        timings: { ...st.timings, evalMs: null },
      }));
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function performanceNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * The DocStore: the open document's source (CadScript), its compiled IR, the evaluation report
 * and display bodies, plus selection and undo/redo.
 *
 * Every change is a transaction on the **source** (recorded with its inverse; see `history.ts`).
 * A change schedules the pipeline: compile + type-check (debounced while typing) → evaluate when
 * the IR actually changed. Results of superseded runs are dropped (revision check), so the state
 * always describes the latest source.
 *
 * ADR 0010 foresees Immer now and a Loro CRDT later behind this interface; with source-level
 * transactions and small immutable snapshots, plain objects suffice for this spike.
 */
import type { EvalReport, IrDocument } from "@aicad/ir-types";
import type { CadScriptService, CompileOutput } from "../cadscript/service";
import type { ForgeEngine, PickResult, RenderBody } from "../engine/types";
import { Store } from "../store";
import { History, type TransactionOrigin } from "./history";

export type DocFormat = "cadscript" | "ir-json";

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
}

export interface DocDescriptor {
  path: string | null;
  name: string;
  format: DocFormat;
  source: string;
  /** The IR the source was printed from (IR JSON files): its part/feature ids are kept on compile. */
  baseIr?: IrDocument;
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
  /** Recompile delay after a coalesced (typing) edit, ms. Default 250. */
  debounceMs?: number;
  historyLimit?: number;
  coalesceMs?: number;
  now?: () => number;
}

const EMPTY_SELECTION: Selection = { featureId: null, entity: null, origin: null };

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
      history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    });
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? 250;
    this.now = deps.now ?? (() => Date.now());
    this.history = new History({
      ...(deps.historyLimit !== undefined ? { limit: deps.historyLimit } : {}),
      ...(deps.coalesceMs !== undefined ? { coalesceMs: deps.coalesceMs } : {}),
    });
    this.loadBase = initial?.baseIr ?? null;
    if (initial) this.schedule(0);
  }

  /** Replace the document (open, new, template). Clears history and selection. */
  load(doc: DocDescriptor): void {
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
    });
    this.schedule(0);
  }

  /** Apply a source change as a transaction. Returns false when the source is unchanged. */
  setSource(source: string, options: SetSourceOptions = {}): boolean {
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

  /** End the current (coalescing) transaction, e.g. when the editor loses focus. */
  sealTransaction(): void {
    this.history.seal();
  }

  undo(): boolean {
    const r = this.history.undo(this.getState().source);
    if (!r) return false;
    this.applySource(r.text, 0);
    return true;
  }

  redo(): boolean {
    const r = this.history.redo(this.getState().source);
    if (!r) return false;
    this.applySource(r.text, 0);
    return true;
  }

  /** After a successful save: the current source is the saved one. */
  markSaved(update: { path: string; name: string; format: DocFormat }): void {
    this.setState((s) => ({ ...update, savedSource: s.source, dirty: false }));
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

  /** Resolves when the pipeline has settled for the current source. */
  idle(timeoutMs = 60_000): Promise<DocState> {
    return this.waitFor((s) => s.phase === "idle" && this.timer === null, timeoutMs);
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
      void this.run();
    }, delay);
  }

  private isStale(revision: number, docId: number): boolean {
    const s = this.getState();
    return this.disposed || s.revision !== revision || s.docId !== docId;
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

/**
 * The IR v1 DocStore: the app's document of record — an `aicad.ir/1` document (canonical JSON text,
 * SPEC-v1 §0.4) plus its host state (the rollback marker and body appearance, `@aicad/model-ops`
 * `HostState`) — and the command layer's ops (the op catalogue v2, FULL-MODELING-PLAN §2.2) as
 * undoable transactions (§2.3).
 *
 * - {@link IrDocStore.apply} runs one op as one transaction; {@link IrDocStore.transaction} runs
 *   several as **one** undo step (a tool's OK, a finished sketch with its new parameters). A
 *   transaction is atomic: if any op is refused — awaited or not, even one whose refusal the
 *   callback caught — the transaction is refused with that op's error and nothing is recorded.
 * - Every transaction passes the commit checks (`@aicad/model-ops` `OpTransaction`): ADR 0015's
 *   commit check for agent, MCP and CLI origins (`unapproved_user_change`) and the failure rule
 *   (`COMMAND_FEATURE_FAILS`; `COMMAND_NEW_FAILURES` unless `ack` lists exactly the newly failing
 *   features). Authorship is stamped from the transaction's `origin`.
 * - Every transaction records the exact inverse of its edit (a text edit on the canonical document
 *   and its host state, `history.ts`): undo restores the previous document byte for byte, redo the
 *   next, whatever the op did — engine-computed writes (solutions, captures) are never recomputed.
 * - **Groups** (§2.3): `openGroup({ label, origin })` starts a group — each transaction in it is
 *   visible at once and is its own step on a local stack (undo inside the group undoes one step);
 *   `sealGroup()` collapses the group into ONE step on the main stack (an agent turn, an edited
 *   sketch); `abortGroup()` restores the document from before the group. Groups don't nest.
 * - The document of record is canonical: {@link IrDocStore.load} stores every expression in its
 *   canonical form and refuses a document whose canonical form would be rejected ([W0-20]).
 * - §0.6 write-back: after the ops of a transaction the store runs `writeBackSolution` inside the
 *   same transaction (option `autoWriteBack`, on by default), to its fixed point; a write-back the
 *   engine cannot do is skipped and the outcome says so (`writeBackSkipped`), sketches whose
 *   solution would fail are withheld (`writeBackWithheld`). Capture-writing ops run on the
 *   written-back document.
 * - Ops are serialised: transactions run one at a time, and the ops of one transaction too. A
 *   transaction handle is closed when its callback settles (`IR_TRANSACTION_CLOSED`). A transaction
 *   whose base changed underneath it (an undo while the engine was working) is refused.
 * - {@link IrDocStore.onDidChange} tells the UI and the agent about every commit, undo, redo, load
 *   and group step (who, what, which revision).
 */
import type { metricsV1 } from "@aicad/ir-types";
import {
  EMPTY_HOST_STATE,
  hostStateEqual,
  OpTransaction,
  type Approvals,
  type HostState,
  type NewFailure,
  type OpOrigin,
} from "@aicad/model-ops";
import { History } from "../history";
import { Store } from "../../store";
import { CommandEngineError, requireCommandEngine, type IrCommandEngine } from "./command-engine";
import { applyOp, opLabel, type ApplyOptions, type IrOp, type OpOutcome } from "./ops";

export interface IrDocGroup {
  label: string;
  origin: OpOrigin;
  /** Transactions committed in the group so far (undo inside the group lowers it). */
  steps: number;
}

export interface IrDocState {
  /** The canonical `aicad.ir/1` text, or null before a document is loaded. */
  document: string | null;
  /** The rollback marker and appearance, recorded with the document. */
  host: HostState;
  /** Increments on every change of `document` or `host`. */
  revision: number;
  /** The `params` block of `document` (every value or failure), refreshed after each change. */
  params: metricsV1.ParamReport[] | null;
  /** An op or transaction is running. */
  busy: boolean;
  history: { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };
  /** The last committed transaction (for transcripts and the agent). */
  last: TransactionOutcome | null;
  /** The open group, if any. */
  group: IrDocGroup | null;
}

export interface IrDocStoreDeps {
  /** The engine's command layer (null when the active engine has none). */
  engine: () => IrCommandEngine | null;
  /** Run `writeBackSolution` after every transaction's ops, inside it (§0.6). Default true. */
  autoWriteBack?: boolean;
  /** Apply the failure rule to every transaction (FULL-MODELING-PLAN §2.2). Default true. */
  failureRule?: boolean;
  historyLimit?: number;
  now?: () => number;
}

export interface TransactionOptions {
  /** Who issues it (default `command`); authorship and the commit check follow from it. */
  origin?: OpOrigin;
  /** Undo label (default: the first op's label). */
  label?: string;
  /** Acknowledged newly failing features ("Apply anyway": the ids `COMMAND_NEW_FAILURES` listed). */
  ack?: readonly string[];
  /** What an agent/MCP/CLI transaction may change of the user's (ADR 0015); host code only. */
  approvals?: Approvals;
}

export interface TransactionOutcome {
  label: string;
  origin: OpOrigin;
  /** Whether the document or its host state changed (an unchanged transaction records nothing). */
  changed: boolean;
  /**
   * Each op's outcome, in order, with the automatic write-backs where they changed something:
   * before each capture-writing op, and last.
   */
  ops: OpOutcome[];
  /** Why the automatic write-back was not applied (the edit is committed without it). */
  writeBackSkipped?: { code: string; message: string; details?: Record<string, unknown> };
  /** Constrained sketches the last write-back withheld (their solution would fail them). */
  writeBackWithheld?: Array<{ sketch: string; code?: string }>;
  /** Newly failing features the transaction acknowledged. */
  newFailures?: NewFailure[];
  /** The document and host state after the transaction. */
  document: string;
  host: HostState;
}

/** The handle a {@link IrDocStore.transaction} callback applies ops through. */
export interface IrTransaction {
  /** The working document (canonical text), including the ops applied so far. */
  readonly document: string;
  /**
   * Apply an op to the working document. Calls run one at a time in call order (a call made
   * while another runs waits for it); a call after the transaction's callback settled is
   * refused with `IR_TRANSACTION_CLOSED`.
   */
  apply(op: IrOp): Promise<OpOutcome>;
}

/** What {@link IrDocStore.onDidChange} reports. */
export interface IrDocChange {
  kind: "load" | "commit" | "undo" | "redo" | "group-open" | "group-seal" | "group-abort";
  label: string;
  origin: OpOrigin;
  revision: number;
  /** The transaction, for `commit`. */
  outcome?: TransactionOutcome;
}

const HOST_MARK = "\n\u0001host:";

/** The history's text: the document, and the host state when there is any. */
function snapshotText(document: string, host: HostState): string {
  return hostStateEqual(host, EMPTY_HOST_STATE) ? document : `${document}${HOST_MARK}${JSON.stringify({ rollback: host.rollback, appearance: host.appearance })}`;
}

function parseSnapshot(text: string): { document: string; host: HostState } {
  const i = text.lastIndexOf(HOST_MARK);
  if (i < 0) return { document: text, host: EMPTY_HOST_STATE };
  const h = JSON.parse(text.slice(i + HOST_MARK.length)) as HostState;
  return { document: text.slice(0, i), host: { rollback: h.rollback ?? null, appearance: h.appearance ?? {} } };
}

const REPORT_CACHE = 6;

export class IrDocStore extends Store<IrDocState> {
  private readonly deps: IrDocStoreDeps;
  private readonly history: History;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private groupState: { base: string; history: History } | null = null;
  private readonly reports = new Map<string, Promise<metricsV1.EvalReport>>();
  private readonly changeListeners = new Set<(e: IrDocChange) => void>();

  constructor(deps: IrDocStoreDeps) {
    super({
      document: null,
      host: EMPTY_HOST_STATE,
      revision: 0,
      params: null,
      busy: false,
      history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
      last: null,
      group: null,
    });
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.history = this.newHistory();
  }

  private newHistory(): History {
    return new History(this.deps.historyLimit !== undefined ? { limit: this.deps.historyLimit, coalesceMs: 0 } : { coalesceMs: 0 });
  }

  /** The engine's command layer (for read-only queries: dependents, parameter uses). */
  commandEngine(): IrCommandEngine {
    return requireCommandEngine(this.deps.engine());
  }

  private engine(): IrCommandEngine {
    return this.commandEngine();
  }

  /** The document of record; throws when none is loaded. */
  get document(): string {
    const d = this.getState().document;
    if (d === null) throw new CommandEngineError("IR_NO_DOCUMENT", "no IR v1 document is loaded (load one first)");
    return d;
  }

  /** The rollback marker (the last feature that is built), or null. */
  get marker(): string | null {
    return this.getState().host.rollback;
  }

  /** Called after every load, commit, undo, redo and group step. */
  onDidChange(listener: (e: IrDocChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emit(e: IrDocChange): void {
    for (const l of [...this.changeListeners]) {
      try {
        l(e);
      } catch (err) {
        console.error("[ir] change listener failed", err);
      }
    }
  }

  /**
   * Load a document of either IR version (a v0 document is migrated, SPEC-v1 §9.1) as the new
   * document of record, every expression in canonical form (§2.4), with its host state (default
   * none); clears the history and any group. Refused (the engine's rejection, e.g.
   * `PARAM_OUT_OF_RANGE` at a site's path) when the document, or only its canonical form
   * ([W0-20]), would be rejected. Returns the canonical text and the migration's renames.
   */
  load(text: string, options: { host?: HostState } = {}): Promise<{ document: string; renames: metricsV1.IdRename[] }> {
    return this.serial(async () => {
      const m = await this.engine().canonicalize(text);
      this.history.clear();
      this.groupState = null;
      const host = options.host ?? EMPTY_HOST_STATE;
      this.setState((s) => ({ document: m.document, host, revision: s.revision + 1, last: null, group: null, history: this.historyState() }));
      this.emit({ kind: "load", label: "Open", origin: "system", revision: this.getState().revision });
      await this.refreshParams();
      return { document: m.document, renames: m.renames };
    });
  }

  /** Apply one op as one undoable transaction. */
  apply(op: IrOp, options: TransactionOptions = {}): Promise<TransactionOutcome> {
    return this.transaction(options.label ?? opLabel(op), (tx) => tx.apply(op).then(() => undefined), options);
  }

  /**
   * Run `fn` as one undoable transaction: every op it applies (and the automatic write-back)
   * becomes a single undo step. If `fn` throws, any op it applied was refused (awaited or not,
   * caught or not: the transaction then rejects with the first refusal), or a commit check
   * refuses it, nothing is recorded and the document is unchanged.
   */
  transaction(label: string, fn: (tx: IrTransaction) => Promise<void>, options: TransactionOptions = {}): Promise<TransactionOutcome> {
    return this.serial(async () => {
      const base = this.document;
      const baseHost = this.getState().host;
      const origin = options.origin ?? "command";
      const t = new OpTransaction({
        engine: this.engine(),
        document: base,
        host: baseHost,
        origin,
        autoWriteBack: this.deps.autoWriteBack ?? true,
        failureRule: this.deps.failureRule ?? true,
        report: (d) => this.reportOf(d),
        ...(options.ack ? { ack: options.ack } : {}),
        ...(options.approvals ? { approvals: options.approvals } : {}),
      });
      const tx: IrTransaction = {
        get document() {
          return t.document;
        },
        apply: (op) => t.apply(op),
      };
      this.setState({ busy: true });
      let result;
      try {
        try {
          await fn(tx);
        } finally {
          // Ops the callback started without awaiting them still belong to the transaction, and
          // none may run once it is closed.
          await t.close();
        }
        result = await t.finish();
      } finally {
        this.setState({ busy: false });
      }
      if (this.getState().document !== base || !hostStateEqual(this.getState().host, baseHost)) {
        throw new CommandEngineError("IR_DOCUMENT_CHANGED", "the document changed while the edit was prepared; retry");
      }
      const out: TransactionOutcome = {
        label,
        origin,
        changed: result.changed,
        ops: result.ops,
        document: result.document,
        host: result.host,
        ...(result.writeBackSkipped ? { writeBackSkipped: result.writeBackSkipped } : {}),
        ...(result.writeBackWithheld ? { writeBackWithheld: result.writeBackWithheld } : {}),
        ...(result.newFailures ? { newFailures: result.newFailures } : {}),
      };
      if (result.report) this.cacheReport(result.document, Promise.resolve(result.report));
      if (out.changed) {
        const g = this.getState().group;
        const h = this.groupState ? this.groupState.history : this.history;
        h.record(snapshotText(base, baseHost), snapshotText(result.document, result.host), { label, origin, time: this.now() });
        this.setState((s) => ({
          document: result.document,
          host: result.host,
          revision: s.revision + 1,
          history: this.historyState(),
          last: out,
          ...(g ? { group: { ...g, steps: g.steps + 1 } } : {}),
        }));
        this.emit({ kind: "commit", label, origin, revision: this.getState().revision, outcome: out });
        await this.refreshParams();
      } else {
        this.setState({ last: out });
      }
      return out;
    });
  }

  /** Undo the last transaction (restores the previous document exactly); inside a group, its last step. */
  undo(): boolean {
    return this.step("undo");
  }

  /** Redo the last undone transaction (the recorded edit; nothing is recomputed). */
  redo(): boolean {
    return this.step("redo");
  }

  private step(kind: "undo" | "redo"): boolean {
    const s = this.getState();
    if (s.document === null || s.busy) return false;
    const h = this.groupState ? this.groupState.history : this.history;
    const r = kind === "undo" ? h.undo(snapshotText(s.document, s.host)) : h.redo(snapshotText(s.document, s.host));
    if (!r) return false;
    const next = parseSnapshot(r.text);
    const g = s.group;
    this.setState((st) => ({
      document: next.document,
      host: next.host,
      revision: st.revision + 1,
      history: this.historyState(),
      ...(g ? { group: { ...g, steps: Math.max(0, g.steps + (kind === "undo" ? -1 : 1)) } } : {}),
    }));
    this.emit({ kind, label: r.tx.label, origin: r.tx.origin as OpOrigin, revision: this.getState().revision });
    void this.serial(() => this.refreshParams()).catch(() => undefined);
    return true;
  }

  /**
   * Start a group: its transactions are visible at once and each is a local undo step, until
   * {@link sealGroup} makes the whole group ONE step (e.g. one agent turn) or {@link abortGroup}
   * restores the document from before it. Refused while another group is open.
   */
  openGroup(group: { label: string; origin: OpOrigin }): Promise<void> {
    return this.serial(async () => {
      if (this.groupState) throw new CommandEngineError("IR_GROUP_OPEN", `a group (“${this.getState().group?.label ?? ""}”) is already open; seal or abort it first`);
      const s = this.getState();
      this.groupState = { base: snapshotText(this.document, s.host), history: this.newHistory() };
      this.setState({ group: { label: group.label, origin: group.origin, steps: 0 }, history: this.historyState() });
      this.emit({ kind: "group-open", label: group.label, origin: group.origin, revision: s.revision });
    });
  }

  /** Close the open group as ONE undo step (nothing is recorded when it changed nothing). */
  sealGroup(): Promise<{ changed: boolean; steps: number }> {
    return this.serial(async () => {
      const g = this.getState().group;
      const gs = this.groupState;
      if (!g || !gs) return { changed: false, steps: 0 };
      const s = this.getState();
      const now = snapshotText(this.document, s.host);
      const changed = now !== gs.base;
      if (changed) this.history.record(gs.base, now, { label: g.label, origin: g.origin, time: this.now() });
      this.groupState = null;
      this.setState({ group: null, history: this.historyState() });
      this.emit({ kind: "group-seal", label: g.label, origin: g.origin, revision: s.revision });
      return { changed, steps: g.steps };
    });
  }

  /** Close the open group and restore the document from before it. */
  abortGroup(): Promise<{ aborted: boolean }> {
    return this.serial(async () => {
      const g = this.getState().group;
      const gs = this.groupState;
      if (!g || !gs) return { aborted: false };
      const prev = parseSnapshot(gs.base);
      this.groupState = null;
      const changed = snapshotText(this.document, this.getState().host) !== gs.base;
      this.setState((s) => ({ group: null, document: prev.document, host: prev.host, revision: changed ? s.revision + 1 : s.revision, history: this.historyState() }));
      this.emit({ kind: "group-abort", label: g.label, origin: g.origin, revision: this.getState().revision });
      if (changed) await this.refreshParams();
      return { aborted: true };
    });
  }

  /**
   * What `op` would do to the current document, without committing it (SPEC-v1 §9.2: an upgrade
   * shows its report diff before it is applied).
   */
  preview(op: IrOp, options: Pick<TransactionOptions, "origin"> = {}): Promise<OpOutcome> {
    const o: ApplyOptions = { preview: true, host: this.getState().host, origin: options.origin ?? "command" };
    return this.serial(() => applyOp(this.engine(), this.document, op, o));
  }

  /** The `aicad.metrics/1` report of the current document (references, candidates, probes); cached per document. */
  report(): Promise<metricsV1.EvalReport> {
    return this.serial(() => this.reportOf(this.document));
  }

  /** Resolves once every queued op has finished. */
  idle(): Promise<void> {
    return this.serial(() => Promise.resolve());
  }

  private reportOf(document: string): Promise<metricsV1.EvalReport> {
    const hit = this.reports.get(document);
    if (hit) return hit;
    const p = this.engine().report(document);
    this.cacheReport(document, p);
    p.catch(() => this.reports.delete(document));
    return p;
  }

  private cacheReport(document: string, p: Promise<metricsV1.EvalReport>): void {
    this.reports.delete(document);
    this.reports.set(document, p);
    while (this.reports.size > REPORT_CACHE) this.reports.delete(this.reports.keys().next().value!);
  }

  private historyState(): IrDocState["history"] {
    const h = this.groupState ? this.groupState.history : this.history;
    return { canUndo: h.canUndo, canRedo: h.canRedo, undoLabel: h.undoLabel, redoLabel: h.redoLabel };
  }

  private async refreshParams(): Promise<void> {
    const d = this.getState().document;
    const engine = this.deps.engine();
    if (d === null || !engine) return;
    try {
      const params = await engine.params(d);
      if (this.getState().document === d) this.setState({ params });
    } catch {
      if (this.getState().document === d) this.setState({ params: null });
    }
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

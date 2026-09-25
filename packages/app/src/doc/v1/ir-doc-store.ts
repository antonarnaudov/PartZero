/**
 * The IR v1 DocStore: an `aicad.ir/1` document of record (canonical JSON text, SPEC-v1 §0.4) and
 * its command-layer ops (SPEC-v1 §0.6, §5.9, §9.2; interface I7) as undoable transactions.
 *
 * - {@link IrDocStore.apply} runs one op as one transaction; {@link IrDocStore.transaction} runs
 *   several as **one** undo step (a whole agent turn, or an edit plus its write-back and
 *   capture). A transaction is atomic: if any op is refused — awaited or not, even one whose
 *   refusal the callback caught — the transaction is refused with that op's error and nothing is
 *   recorded.
 * - Every transaction records the exact inverse of its edit (a text edit on the canonical
 *   document, `history.ts`): undo restores the previous document byte for byte, redo the next,
 *   whatever the op did — engine-computed writes (solutions, captures) are never recomputed on
 *   redo.
 * - The document of record is canonical: {@link IrDocStore.load} stores every expression in its
 *   canonical form (SPEC-v1 §2.4: "the DocStore MUST store the canonical form") and refuses a
 *   document whose canonical form would be rejected ([W0-20]); every op returns canonical text.
 * - §0.6 write-back: after the ops of a transaction, the store runs `writeBackSolution` inside the
 *   same transaction (option `autoWriteBack`, on by default), so solved sketch geometry is stored
 *   with the edit that re-solved it and undone with it. The engine's write-back runs to its fixed
 *   point (§4.4 rule 9 [W0-31]: a solve that welds ends moves the geometry again on the next
 *   pass), so no later transaction carries a leftover geometry change. It never makes the model
 *   fail: a sketch whose written-back solution would fail it is withheld and the outcome lists it
 *   (`writeBackWithheld`). When the engine cannot evaluate the document at all (a feature type it
 *   does not implement yet) or refuses the write-back (`COMMAND_NOT_EXACT`: no fixed point, or a
 *   feature would fail), the edit is committed without it and the outcome says so
 *   (`writeBackSkipped`).
 * - Captures describe the stored geometry: before an op that writes a capture (`captureRef`,
 *   `acceptRefCandidate`, `acceptRefProposal`) the automatic write-back brings the working
 *   document to its fixed point, so the capture is taken on the geometry that is committed and a
 *   second `captureRef` changes nothing (op-level idempotence, also when a solve welds ends).
 *   Captures are **not** refreshed on commit (ADR 0013 decision 4): only `captureRef` and the
 *   repairs write them.
 * - A repair names what the caller read in a report — possibly of the document *before* that
 *   write-back (a loaded document is not written back). `acceptRefCandidate` therefore carries the
 *   candidate's `probe` (`repairOps` adds it): the engine refuses the op
 *   (`COMMAND_CANDIDATE_CHANGED`) when the chosen candidate is no longer that entity. A
 *   `candidateIndex` without a `probe` is refused the same way when the write-back changed the
 *   document, since the index may then name another split piece.
 * - Ops are serialised: transactions run one at a time, and the ops of one transaction too (a
 *   `tx.apply` issued while another is running waits for it, so concurrent calls such as
 *   `Promise.all` apply in call order, each to the previous one's result). A transaction handle
 *   is closed when its callback settles: a later `tx.apply` is refused (`IR_TRANSACTION_CLOSED`).
 *   A transaction whose base changed underneath it (an undo while the engine was working) is
 *   refused rather than applied to a stale document.
 *
 * The CadScript-source `DocStore` stays v0 until the app's pipeline moves to CadScript v1; then it
 * delegates its IR-level ops here (captures live in the compile base, never in the source).
 */
import type { metricsV1 } from "@aicad/ir-types";
import { History, type TransactionOrigin } from "../history";
import { Store } from "../../store";
import { CommandEngineError, requireCommandEngine, type IrCommandEngine, type WriteBackResult } from "./command-engine";
import { applyOp, opLabel, type ApplyOptions, type IrOp, type IrOpName, type OpOutcome } from "./ops";

/**
 * The engine's refusals of an automatic write-back that leave the edit valid on its own: a
 * document it cannot evaluate (a feature type it does not implement), and a write-back that fails
 * its verification (`COMMAND_NOT_EXACT`: no fixed point, or a feature would fail). The edit is then
 * committed without the write-back.
 */
const WRITE_BACK_REFUSALS = ["UNSUPPORTED_FEATURE_VERSION", "UNSUPPORTED_FEATURE", "COMMAND_NOT_EXACT"];

/** Ops that write a capture of the evaluated geometry: they run on the written-back document. */
const CAPTURE_OPS: ReadonlySet<IrOpName> = new Set<IrOpName>(["captureRef", "acceptRefCandidate", "acceptRefProposal"]);

const closedError = () =>
  new CommandEngineError("IR_TRANSACTION_CLOSED", "this transaction has finished; apply the op in a new transaction");

export interface IrDocState {
  /** The canonical `aicad.ir/1` text, or null before a document is loaded. */
  document: string | null;
  /** Increments on every change of `document`. */
  revision: number;
  /** The `params` block of `document` (every value or failure), refreshed after each change. */
  params: metricsV1.ParamReport[] | null;
  /** An op or transaction is running. */
  busy: boolean;
  history: { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };
  /** The last committed transaction (for transcripts and the agent). */
  last: TransactionOutcome | null;
}

export interface IrDocStoreDeps {
  /** The engine's command layer (null when the active engine has none). */
  engine: () => IrCommandEngine | null;
  /** Run `writeBackSolution` after every transaction's ops, inside it (§0.6). Default true. */
  autoWriteBack?: boolean;
  historyLimit?: number;
  now?: () => number;
}

export interface TransactionOptions {
  origin?: TransactionOrigin;
  /** Undo label (default: the first op's label). */
  label?: string;
}

export interface TransactionOutcome {
  label: string;
  origin: TransactionOrigin;
  /** Whether the document changed (an unchanged transaction records nothing). */
  changed: boolean;
  /**
   * Each op's outcome, in order, with the automatic write-backs where they changed something:
   * before each capture-writing op, and last.
   */
  ops: OpOutcome[];
  /**
   * Why the automatic write-back was not applied: the engine cannot evaluate the document (a
   * feature type it does not implement yet, `UNSUPPORTED_FEATURE_VERSION` /
   * `UNSUPPORTED_FEATURE`), or it refused the write-back (`COMMAND_NOT_EXACT`, `details.reason`
   * "no fixed point" or "a feature would fail"). The edit is committed without it.
   */
  writeBackSkipped?: { code: string; message: string; details?: Record<string, unknown> };
  /**
   * Constrained sketches the last write-back of the transaction withheld: their written-back
   * solution would fail them with `code` (SPEC-v1 §4.4 rule 9 [W0-31]: the weld of ends the
   * solve brought within tol turns a driving distance ≤ tol into `SKETCH_CONSTRAINT_CONFLICT`).
   * Their stored geometry is unchanged and the model still evaluates; the sketch needs an edit
   * (e.g. a larger distance, or a `coincident`).
   */
  writeBackWithheld?: Array<{ sketch: string; code?: string }>;
  /** The document after the transaction. */
  document: string;
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

export class IrDocStore extends Store<IrDocState> {
  private readonly deps: IrDocStoreDeps;
  private readonly history: History;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: IrDocStoreDeps) {
    super({
      document: null,
      revision: 0,
      params: null,
      busy: false,
      history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
      last: null,
    });
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.history = new History(deps.historyLimit !== undefined ? { limit: deps.historyLimit, coalesceMs: 0 } : { coalesceMs: 0 });
  }

  private engine(): IrCommandEngine {
    return requireCommandEngine(this.deps.engine());
  }

  /** The document of record; throws when none is loaded. */
  get document(): string {
    const d = this.getState().document;
    if (d === null) throw new CommandEngineError("IR_NO_DOCUMENT", "no IR v1 document is loaded (load one first)");
    return d;
  }

  /**
   * Load a document of either IR version (a v0 document is migrated, SPEC-v1 §9.1) as the new
   * document of record, every expression in canonical form (§2.4); clears the history. Refused
   * (the engine's rejection, e.g. `PARAM_OUT_OF_RANGE` at a site's path) when the document, or
   * only its canonical form ([W0-20]), would be rejected. Returns the canonical text and the
   * migration's renames.
   */
  load(text: string): Promise<{ document: string; renames: metricsV1.IdRename[] }> {
    return this.serial(async () => {
      const m = await this.engine().canonicalize(text);
      this.history.clear();
      this.setState((s) => ({ document: m.document, revision: s.revision + 1, last: null, history: this.historyState() }));
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
   * becomes a single undo step. If `fn` throws, or any op it applied was refused (awaited or not,
   * caught or not: the transaction then rejects with the first refusal), nothing is recorded and
   * the document is unchanged.
   */
  transaction(label: string, fn: (tx: IrTransaction) => Promise<void>, options: TransactionOptions = {}): Promise<TransactionOutcome> {
    return this.serial(async () => {
      const base = this.document;
      const engine = this.engine();
      const auto = this.deps.autoWriteBack ?? true;
      const outcomes: OpOutcome[] = [];
      let working = base;
      let closed = false;
      // The first refused op, awaited or not: the transaction is refused with it.
      let failed = false;
      let failure: unknown;
      let writeBackSkipped: TransactionOutcome["writeBackSkipped"];
      let withheld: TransactionOutcome["writeBackWithheld"];
      // A working text known to be at its write-back fixed point.
      let written: string | null = null;
      const noteWriteBack = (o: OpOutcome) => {
        const r = o.result as Omit<WriteBackResult, "document">;
        withheld = (r.skipped ?? []).filter((x) => x.reason === "would-fail").map((x) => ({ sketch: x.sketch, ...(x.code ? { code: x.code } : {}) }));
      };
      // The automatic write-back (§0.6) of the working document, to its fixed point.
      const writeBack = async (): Promise<void> => {
        if (working === written) return;
        try {
          const wb = await applyOp(engine, working, { op: "writeBackSolution" });
          noteWriteBack(wb);
          if (wb.changed) {
            working = wb.document;
            outcomes.push(wb);
          }
        } catch (e) {
          // The edit stands without it (see WRITE_BACK_REFUSALS).
          if (!(e instanceof CommandEngineError) || !WRITE_BACK_REFUSALS.includes(e.code)) throw e;
          writeBackSkipped = { code: e.code, message: e.message, ...(Object.keys(e.details).length ? { details: e.details } : {}) };
        }
        written = working;
      };
      // The ops of this transaction, chained: each runs on the previous one's result.
      let chain: Promise<unknown> = Promise.resolve();
      const tx: IrTransaction = {
        get document() {
          return working;
        },
        apply: (op) => {
          if (closed) return Promise.reject(closedError());
          const run = chain.then(async () => {
            if (closed) throw closedError();
            // A capture describes the geometry that is committed: the written-back document.
            if (auto && CAPTURE_OPS.has(op.op)) {
              const read = working;
              await writeBack();
              if (op.op === "acceptRefCandidate" && op.candidateIndex !== undefined && op.probe === undefined && working !== read) {
                throw new CommandEngineError(
                  "COMMAND_CANDIDATE_CHANGED",
                  `the document was written back (solved sketch geometry, SPEC-v1 §0.6) before repairing ${op.feature}${op.field}, ` +
                    "so a candidateIndex read from the report before may name another piece: pass the candidate's probe",
                  [],
                  {
                    feature: op.feature,
                    field: op.field,
                    member: op.member,
                    candidate: op.candidate,
                    index: op.candidateIndex,
                    reason: "written-back",
                  },
                );
              }
            }
            const atFixedPoint = working === written;
            const o = await applyOp(engine, working, op);
            working = o.document;
            outcomes.push(o);
            if (o.op.op === "writeBackSolution") {
              noteWriteBack(o);
              if (!o.op.sketches) written = working;
            } else if (o.op.op === "captureRef" && atFixedPoint) {
              // A capture keeps the reference's members (the engine verifies it), so the geometry
              // and its solutions are unchanged: still at the fixed point.
              written = working;
            }
            return o;
          });
          // Never rejects: the refusal is kept for the transaction (and returned to the caller).
          chain = run.then(
            () => undefined,
            (e: unknown) => {
              if (!failed) {
                failed = true;
                failure = e;
              }
            },
          );
          return run;
        },
      };
      this.setState({ busy: true });
      try {
        try {
          await fn(tx);
        } finally {
          // Ops the callback started without awaiting them still belong to the transaction
          // (each op applies fully or not at all; a refused one leaves the working document), and
          // none may run once it is closed.
          let settled: Promise<unknown>;
          do {
            settled = chain;
            await settled;
          } while (settled !== chain);
          closed = true;
        }
        // Atomic: a refused op refuses the whole transaction, before any write-back or commit.
        if (failed) throw failure;
        const edited = outcomes.some((o) => o.changed && o.op.op !== "writeBackSolution");
        if (edited && auto) await writeBack();
      } finally {
        this.setState({ busy: false });
      }
      if (this.getState().document !== base) {
        throw new CommandEngineError("IR_DOCUMENT_CHANGED", "the document changed while the edit was prepared; retry");
      }
      const origin = options.origin ?? "command";
      const changed = working !== base;
      const out: TransactionOutcome = {
        label,
        origin,
        changed,
        ops: outcomes,
        document: working,
        ...(writeBackSkipped ? { writeBackSkipped } : {}),
        ...(withheld && withheld.length ? { writeBackWithheld: withheld } : {}),
      };
      if (changed) {
        this.history.record(base, working, { label, origin, time: this.now() });
        this.setState((s) => ({ document: working, revision: s.revision + 1, history: this.historyState(), last: out }));
        await this.refreshParams();
      } else {
        this.setState({ last: out });
      }
      return out;
    });
  }

  /** Undo the last transaction (restores the previous document exactly). */
  undo(): boolean {
    const d = this.getState().document;
    if (d === null || this.getState().busy) return false;
    const r = this.history.undo(d);
    if (!r) return false;
    this.setState((s) => ({ document: r.text, revision: s.revision + 1, history: this.historyState() }));
    void this.serial(() => this.refreshParams()).catch(() => undefined);
    return true;
  }

  /** Redo the last undone transaction (the recorded edit; nothing is recomputed). */
  redo(): boolean {
    const d = this.getState().document;
    if (d === null || this.getState().busy) return false;
    const r = this.history.redo(d);
    if (!r) return false;
    this.setState((s) => ({ document: r.text, revision: s.revision + 1, history: this.historyState() }));
    void this.serial(() => this.refreshParams()).catch(() => undefined);
    return true;
  }

  /**
   * What `op` would do to the current document, without committing it (SPEC-v1 §9.2: an upgrade
   * shows its report diff before it is applied).
   */
  preview(op: IrOp): Promise<OpOutcome> {
    const options: ApplyOptions = { preview: true };
    return this.serial(() => applyOp(this.engine(), this.document, op, options));
  }

  /** The `aicad.metrics/1` report of the current document (references, candidates, probes). */
  report(): Promise<metricsV1.EvalReport> {
    return this.serial(() => this.engine().report(this.document));
  }

  /** Resolves once every queued op has finished. */
  idle(): Promise<void> {
    return this.serial(() => Promise.resolve());
  }

  private historyState(): IrDocState["history"] {
    return {
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      undoLabel: this.history.undoLabel,
      redoLabel: this.history.redoLabel,
    };
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

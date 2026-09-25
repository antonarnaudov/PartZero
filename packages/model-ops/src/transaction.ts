/**
 * One transaction's working state: ops applied in order to a working document, the automatic
 * write-back (SPEC-v1 §0.6), and the commit checks (the failure rule and ADR 0015's commit check,
 * `rules.ts`). A store (the app's `IrDocStore`, {@link MemoryOpsHost}) runs one {@link OpTransaction}
 * per undo step and records `base → document` only if {@link OpTransaction.finish} succeeds.
 *
 * - Ops run one at a time in call order (a call made while another runs waits for it), each on the
 *   previous one's result. After `close()` (the transaction's callback settled) a call is refused
 *   (`IR_TRANSACTION_CLOSED`).
 * - Atomic: the first refused op, awaited or not, refuses the whole transaction.
 * - Write-back: before an op that writes a capture of the evaluated geometry (`captureRef`, the
 *   reference repairs) the working document is brought to its write-back fixed point, so the
 *   capture describes what is committed; after the ops, once more. A write-back the engine cannot do
 *   (a feature type it does not implement, or `COMMAND_NOT_EXACT`) is skipped, and the outcome says
 *   so; sketches whose written-back solution would fail are withheld and listed.
 */
import type { metricsV1 } from "@aicad/ir-types";
import { applyOp, hostStateEqual, type HostState, type OpOrigin, type OpOutcome, type Touched } from "./apply.js";
import type { IrOp, IrOpName } from "./catalogue.js";
import { CommandEngineError, type IrCommandEngine, type WriteBackResult } from "./engine.js";
import { checkApprovals, checkFailureRule, type Approvals, type NewFailure } from "./rules.js";

/**
 * The engine's refusals of an automatic write-back that leave the edit valid on its own: a
 * document it cannot evaluate (a feature type it does not implement), and a write-back that fails
 * its verification (`COMMAND_NOT_EXACT`: no fixed point, or a feature would fail). The edit is then
 * committed without the write-back.
 */
export const WRITE_BACK_REFUSALS: readonly string[] = ["UNSUPPORTED_FEATURE_VERSION", "UNSUPPORTED_FEATURE", "COMMAND_NOT_EXACT"];

/** Ops that write a capture of the evaluated geometry: they run on the written-back document. */
export const CAPTURE_OPS: ReadonlySet<IrOpName> = new Set<IrOpName>(["captureRef", "acceptRefCandidate", "acceptRefProposal"]);

export const closedError = (): CommandEngineError =>
  new CommandEngineError("IR_TRANSACTION_CLOSED", "this transaction has finished; apply the op in a new transaction");

export interface TransactionSettings {
  engine: IrCommandEngine;
  /** The committed document (canonical text) and host state the transaction starts from. */
  document: string;
  host: HostState;
  origin: OpOrigin;
  /** Run `writeBackSolution` after the ops (and before capture ops), inside the transaction. Default true. */
  autoWriteBack?: boolean;
  /** Apply the failure rule (default true). */
  failureRule?: boolean;
  /** Acknowledged newly failing features ("Apply anyway"). */
  ack?: readonly string[];
  /** What an agent/MCP/CLI transaction may change of the user's (ADR 0015). */
  approvals?: Approvals;
  /** The report of a document (a store caches the committed one). */
  report?: (document: string) => Promise<metricsV1.EvalReport>;
}

export interface TransactionResult {
  /** The working document (canonical text) and host state after the transaction. */
  document: string;
  host: HostState;
  /** Whether the IR text or the host state changed. */
  changed: boolean;
  /** Each op's outcome, in order, with the automatic write-backs where they changed something. */
  ops: OpOutcome[];
  /** Why the automatic write-back was not applied (see {@link WRITE_BACK_REFUSALS}). */
  writeBackSkipped?: { code: string; message: string; details?: Record<string, unknown> };
  /** Constrained sketches whose written-back solution would fail them (withheld; SPEC-v1 §4.4 rule 9 [W0-31]). */
  writeBackWithheld?: Array<{ sketch: string; code?: string }>;
  /** Newly failing features the transaction acknowledged. */
  newFailures?: NewFailure[];
  /** The report of the committed document, when the failure rule computed it. */
  report?: metricsV1.EvalReport;
}

/** The working state of one transaction (see the file comment). */
export class OpTransaction {
  readonly base: string;
  readonly baseHost: HostState;
  private working: string;
  private workingHost: HostState;
  private readonly settings: TransactionSettings;
  private readonly auto: boolean;
  private readonly outcomes: OpOutcome[] = [];
  private closed = false;
  private failed = false;
  private failure: unknown;
  private chain: Promise<unknown> = Promise.resolve();
  /** A working text known to be at its write-back fixed point. */
  private written: string | null = null;
  private writeBackSkipped: TransactionResult["writeBackSkipped"];
  private withheld: TransactionResult["writeBackWithheld"];
  /** The working document after the transaction's own ops, before the final write-back (for the commit check). */
  private beforeFinalWriteBack: string | null = null;

  constructor(settings: TransactionSettings) {
    this.settings = settings;
    this.base = settings.document;
    this.baseHost = settings.host;
    this.working = settings.document;
    this.workingHost = settings.host;
    this.auto = settings.autoWriteBack ?? true;
  }

  /** The working document (canonical text), including the ops applied so far. */
  get document(): string {
    return this.working;
  }

  get host(): HostState {
    return this.workingHost;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private noteWriteBack(o: OpOutcome): void {
    const r = o.result as Omit<WriteBackResult, "document">;
    this.withheld = (r.skipped ?? []).filter((x) => x.reason === "would-fail").map((x) => ({ sketch: x.sketch, ...(x.code ? { code: x.code } : {}) }));
  }

  /** The automatic write-back (§0.6) of the working document, to its fixed point. */
  private async writeBack(): Promise<void> {
    if (this.working === this.written) return;
    try {
      const wb = await applyOp(this.settings.engine, this.working, { op: "writeBackSolution" }, { origin: "system" });
      this.noteWriteBack(wb);
      if (wb.changed) {
        this.working = wb.document;
        this.outcomes.push(wb);
      }
    } catch (e) {
      // The edit stands without it (see WRITE_BACK_REFUSALS).
      if (!(e instanceof CommandEngineError) || !WRITE_BACK_REFUSALS.includes(e.code)) throw e;
      this.writeBackSkipped = { code: e.code, message: e.message, ...(Object.keys(e.details).length ? { details: e.details } : {}) };
    }
    this.written = this.working;
  }

  /**
   * Apply an op to the working document. Calls run one at a time in call order; a call after
   * {@link close} is refused with `IR_TRANSACTION_CLOSED`. The first refusal refuses the whole
   * transaction (it is also returned to the caller).
   */
  apply(op: IrOp): Promise<OpOutcome> {
    if (this.closed) return Promise.reject(closedError());
    const run = this.chain.then(async () => {
      if (this.closed) throw closedError();
      // A capture describes the geometry that is committed: the written-back document.
      if (this.auto && CAPTURE_OPS.has(op.op)) {
        const read = this.working;
        await this.writeBack();
        if (op.op === "acceptRefCandidate" && op.candidateIndex !== undefined && op.probe === undefined && this.working !== read) {
          throw new CommandEngineError(
            "COMMAND_CANDIDATE_CHANGED",
            `the document was written back (solved sketch geometry, SPEC-v1 §0.6) before repairing ${op.feature}${op.field}, ` +
              "so a candidateIndex read from the report before may name another piece: pass the candidate's probe",
            [],
            { feature: op.feature, field: op.field, member: op.member, candidate: op.candidate, index: op.candidateIndex, reason: "written-back" },
          );
        }
      }
      const atFixedPoint = this.working === this.written;
      const o = await applyOp(this.settings.engine, this.working, op, { origin: this.settings.origin, host: this.workingHost });
      this.working = o.document;
      if (o.host) this.workingHost = o.host;
      this.outcomes.push(o);
      if (o.op.op === "writeBackSolution") {
        this.noteWriteBack(o);
        if (!o.op.sketches) this.written = this.working;
      } else if (o.op.op === "captureRef" && atFixedPoint) {
        // A capture keeps the reference's members (the engine verifies it), so the geometry and
        // its solutions are unchanged: still at the fixed point.
        this.written = this.working;
      }
      return o;
    });
    // Never rejects: the refusal is kept for the transaction (and returned to the caller).
    this.chain = run.then(
      () => undefined,
      (e: unknown) => {
        if (!this.failed) {
          this.failed = true;
          this.failure = e;
        }
      },
    );
    return run;
  }

  /** Wait for every op started so far (also ones the caller did not await), then refuse later ones. */
  async close(): Promise<void> {
    let settled: Promise<unknown>;
    do {
      settled = this.chain;
      await settled;
    } while (settled !== this.chain);
    this.closed = true;
  }

  /** What the transaction's own ops touched (for the failure rule). */
  touched(): Touched {
    const t: Touched = { features: [], params: [], suppressed: [] };
    for (const o of this.outcomes) {
      t.features.push(...o.touched.features);
      t.params.push(...o.touched.params);
      t.suppressed.push(...o.touched.suppressed);
    }
    return t;
  }

  /**
   * After {@link close}: throw the first refusal, else run the final write-back and the commit
   * checks, and return the result (the store commits it).
   */
  async finish(): Promise<TransactionResult> {
    if (!this.closed) await this.close();
    if (this.failed) throw this.failure;
    const edited = this.outcomes.some((o) => o.changed && o.op.op !== "writeBackSolution");
    this.beforeFinalWriteBack = this.working;
    if (edited && this.auto) await this.writeBack();
    const changed = this.working !== this.base || !hostStateEqual(this.workingHost, this.baseHost);
    const result: TransactionResult = {
      document: this.working,
      host: this.workingHost,
      changed,
      ops: this.outcomes,
      ...(this.writeBackSkipped ? { writeBackSkipped: this.writeBackSkipped } : {}),
      ...(this.withheld && this.withheld.length ? { writeBackWithheld: this.withheld } : {}),
    };
    if (!changed) return result;
    // ADR 0015's commit check, on the transaction's own ops (the write-back follows from them) and
    // on the host state (a transaction that only recolours or moves the marker is checked too).
    const setsRollback = this.outcomes.some((o) => o.op.op === "setRollback" && o.changed);
    const rollback = setsRollback && this.workingHost.rollback !== this.baseHost.rollback ? { from: this.baseHost.rollback, to: this.workingHost.rollback } : null;
    checkApprovals({
      base: this.base,
      after: this.beforeFinalWriteBack,
      origin: this.settings.origin,
      approvals: this.settings.approvals,
      baseHost: this.baseHost,
      afterHost: this.workingHost,
      rollback,
    });
    if (this.working === this.base) return result;
    if (this.settings.failureRule ?? true) {
      const report = this.settings.report ?? ((d: string) => this.settings.engine.report(d));
      const [before, after] = await Promise.all([report(this.base), report(this.working)]);
      const fresh = checkFailureRule({
        before,
        after,
        touched: this.touched(),
        ack: this.settings.ack,
        origin: this.settings.origin,
        base: this.base,
        approvals: this.settings.approvals,
      });
      if (fresh.length) result.newFailures = fresh;
      result.report = after;
    }
    return result;
  }
}

/** Run `ops` as one transaction on `settings.document` (no store: the caller commits the result). */
export async function runTransaction(settings: TransactionSettings, ops: readonly IrOp[]): Promise<TransactionResult> {
  const tx = new OpTransaction(settings);
  for (const op of ops) {
    try {
      await tx.apply(op);
    } catch {
      break;
    }
  }
  await tx.close();
  return tx.finish();
}

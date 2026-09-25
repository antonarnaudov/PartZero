/**
 * What the agent's op tools and the MCP server need from whoever holds the document: an
 * {@link OpsHost}. The app implements it over its command registry (the live document: every op
 * the agent issues is a command the user sees land); {@link MemoryOpsHost} holds a document in
 * memory (headless MCP, evals, tests) with the same transactions, checks and undo.
 */
import type { metricsV1 } from "@aicad/ir-types";
import { EMPTY_HOST_STATE, needsApproval, type HostState, type OpOrigin, type OpOutcome } from "./apply.js";
import type { IrOp } from "./catalogue.js";
import { opLabel } from "./catalogue.js";
import { requireCommandEngine, type IrCommandEngine } from "./engine.js";
import type { Approvals, NewFailure } from "./rules.js";
import { runTransaction, type TransactionResult } from "./transaction.js";

/**
 * The parameters each agent surface added itself (ADR 0015 §2): parameters have no author, so
 * every existing one is yours, except those an agent, MCP client or the CLI added in this session;
 * it may go on changing those. Shared by every host (the app's `IrDocStore`, {@link MemoryOpsHost})
 * so an agent may do the same thing wherever it runs.
 *
 * - An `addParam` from an agent origin makes the parameter that origin's; its `renameParam` carries
 *   the ownership over, its `deleteParam` ends it.
 * - An op of yours (user, command) on a parameter makes it yours again: a set, rename, delete or a
 *   code edit that touches it.
 */
export class OwnParams {
  private readonly byOrigin = new Map<OpOrigin, Set<string>>();

  /** The approvals of a transaction from `origin`: `approvals` plus the parameters `origin` added. */
  approvalsFor(origin: OpOrigin, approvals: Approvals = {}): Approvals {
    const own = needsApproval(origin) ? [...(this.byOrigin.get(origin) ?? [])] : [];
    return { ...approvals, params: [...(approvals.params ?? []), ...own] };
  }

  /** The parameters `origin` owns now (sorted). */
  owned(origin: OpOrigin): string[] {
    return [...(this.byOrigin.get(origin) ?? [])].sort();
  }

  /** After a committed transaction from `origin`: record what it added, renamed or deleted. */
  record(origin: OpOrigin, ops: readonly OpOutcome[]): void {
    if (needsApproval(origin)) {
      let own = this.byOrigin.get(origin);
      if (!own) this.byOrigin.set(origin, (own = new Set()));
      for (const o of ops) {
        if (o.op.op === "addParam") own.add(o.op.name);
        else if (o.op.op === "renameParam" && own.delete(o.op.old)) own.add(o.op.new);
        else if (o.op.op === "deleteParam") own.delete(o.op.name);
      }
      return;
    }
    const yours = new Set<string>();
    for (const o of ops) {
      for (const p of o.touched.params) yours.add(p);
      if (o.op.op === "addParam" || o.op.op === "setParam" || o.op.op === "deleteParam") yours.add(o.op.name);
      else if (o.op.op === "renameParam") {
        yours.add(o.op.old);
        yours.add(o.op.new);
      }
    }
    for (const own of this.byOrigin.values()) for (const p of yours) own.delete(p);
  }

  /** Forget everything (a new document). */
  clear(): void {
    this.byOrigin.clear();
  }
}

/** A committed (or unchanged) transaction, as hosts report it: no document text. */
export interface OpsCommit {
  changed: boolean;
  label: string;
  /** The document's revision after the transaction. */
  revision: number;
  ops: Array<{ op: IrOp; changed: boolean; result: unknown; inverse: IrOp | null }>;
  newFailures?: NewFailure[];
  writeBackWithheld?: Array<{ sketch: string; code?: string }>;
  writeBackSkipped?: { code: string; message: string };
}

export interface OpsApplyOptions {
  /** The undo label (default: the first op's). */
  label?: string;
  /**
   * Acknowledged newly failing features (the ids a `COMMAND_NEW_FAILURES` refusal listed). It
   * accepts failures of agent-authored features only: making one of the user's features fail needs
   * the user's approval (`unapproved_user_change`).
   */
  ack?: readonly string[];
  /**
   * The undo group (agent turn) this transaction belongs to, from `ir.openGroup`: refused
   * (`IR_GROUP_CLOSED`) once that group is sealed, aborted or its document replaced. Hosts without
   * groups ({@link MemoryOpsHost}) ignore it.
   */
  group?: string;
}

export interface OpsHost {
  /** The document of record (canonical `aicad.ir/1` text). */
  document(): Promise<string>;
  /** The rollback marker and appearance. */
  hostState(): Promise<HostState>;
  /** Apply `ops` as ONE undoable transaction (atomic), as this host's origin (an agent, `mcp:<client>`). */
  apply(ops: readonly IrOp[], options?: OpsApplyOptions): Promise<OpsCommit>;
  /** The `aicad.metrics/1` report of the document. */
  report(): Promise<metricsV1.EvalReport>;
  /** The engine's command layer, for read-only queries (dependents, parameter uses). */
  engine(): IrCommandEngine;
  /**
   * Optional: undo this origin's last transaction (the live agent's "Ask at each step" when the
   * user rejects a step). A host that has no undo for its caller leaves it out; the app allows it
   * inside the agent's own open group only.
   */
  undo?(): Promise<boolean> | boolean;
}

/** The union of two approval sets (ADR 0015 §3). */
export function mergeApprovals(a: Approvals, b: Approvals): Approvals {
  const features = [...new Set([...(a.features ?? []), ...(b.features ?? [])])];
  const params = [...new Set([...(a.params ?? []), ...(b.params ?? [])])];
  return { ...(features.length ? { features } : {}), ...(params.length ? { params } : {}), ...(a.rollback || b.rollback ? { rollback: true } : {}) };
}

/** A transaction result as {@link OpsCommit}. */
export function commitSummary(label: string, revision: number, t: Pick<TransactionResult, "changed" | "ops" | "newFailures" | "writeBackWithheld" | "writeBackSkipped">): OpsCommit {
  return {
    changed: t.changed,
    label,
    revision,
    ops: t.ops.map((o) => ({ op: o.op, changed: o.changed, result: o.result, inverse: o.inverse })),
    ...(t.newFailures?.length ? { newFailures: t.newFailures } : {}),
    ...(t.writeBackWithheld?.length ? { writeBackWithheld: t.writeBackWithheld } : {}),
    ...(t.writeBackSkipped ? { writeBackSkipped: { code: t.writeBackSkipped.code, message: t.writeBackSkipped.message } } : {}),
  };
}

interface Snapshot {
  document: string;
  host: HostState;
  label: string;
}

export interface MemoryOpsHostOptions {
  engine: IrCommandEngine;
  /** The document to start from (either IR version: it is canonicalized). */
  document: string;
  host?: HostState;
  origin: OpOrigin;
  /** ADR 0015 approvals the host's user gave (default none). */
  approvals?: Approvals;
  autoWriteBack?: boolean;
  failureRule?: boolean;
}

/** An in-memory document with transactions and undo/redo (headless MCP, evals, tests). */
export class MemoryOpsHost implements OpsHost {
  private readonly options: MemoryOpsHostOptions;
  private current: Snapshot;
  private readonly undoStack: Snapshot[] = [];
  private readonly redoStack: Snapshot[] = [];
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** Parameters this session's own transactions added (it may change them; the user's need approval). */
  private readonly ownParams = new OwnParams();
  private readonly listeners = new Set<(c: OpsCommit & { document: string }) => void>();
  /** Approvals the host's user gave during the session ({@link MemoryOpsHost.grant}). */
  private granted: Approvals = {};

  private constructor(options: MemoryOpsHostOptions, document: string) {
    this.options = options;
    this.current = { document, host: options.host ?? EMPTY_HOST_STATE, label: "" };
  }

  /** Open a document (canonicalized by the engine; a v0 document is migrated). */
  static async open(options: MemoryOpsHostOptions): Promise<MemoryOpsHost> {
    const engine = requireCommandEngine(options.engine);
    const { document } = await engine.canonicalize(options.document);
    return new MemoryOpsHost(options, document);
  }

  engine(): IrCommandEngine {
    return this.options.engine;
  }

  document(): Promise<string> {
    return Promise.resolve(this.current.document);
  }

  hostState(): Promise<HostState> {
    return Promise.resolve(this.current.host);
  }

  report(): Promise<metricsV1.EvalReport> {
    return this.options.engine.report(this.current.document);
  }

  /** Called after every committed transaction. */
  onDidCommit(listener: (c: OpsCommit & { document: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  apply(ops: readonly IrOp[], options: OpsApplyOptions = {}): Promise<OpsCommit> {
    const run = this.queue.then(async () => {
      const label = options.label ?? (ops[0] ? opLabel(ops[0]) : "Edit");
      const t = await runTransaction(
        {
          engine: this.options.engine,
          document: this.current.document,
          host: this.current.host,
          origin: this.options.origin,
          ...(this.options.autoWriteBack !== undefined ? { autoWriteBack: this.options.autoWriteBack } : {}),
          ...(this.options.failureRule !== undefined ? { failureRule: this.options.failureRule } : {}),
          ...(options.ack ? { ack: options.ack } : {}),
          // Parameters have no author (ADR 0015 §2): those this session added are its own to change.
          approvals: this.ownParams.approvalsFor(this.options.origin, mergeApprovals(this.options.approvals ?? {}, this.granted)),
        },
        ops,
      );
      if (t.changed) {
        this.undoStack.push(this.current);
        this.redoStack.length = 0;
        this.current = { document: t.document, host: t.host, label };
        this.revision++;
        this.ownParams.record(this.options.origin, t.ops);
      }
      const c = commitSummary(label, this.revision, t);
      if (t.changed) for (const l of [...this.listeners]) l({ ...c, document: t.document });
      return c;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Host code only: the user approved these changes to their work (ADR 0015 §3: an answer to the
   * agent's `request_approval`); later transactions of this session may make them. Agents never
   * reach this (it is not an op).
   */
  grant(approvals: Approvals): void {
    this.granted = mergeApprovals(this.granted, approvals);
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.current);
    this.current = prev;
    this.revision++;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.current);
    this.current = next;
    this.revision++;
    return true;
  }
}

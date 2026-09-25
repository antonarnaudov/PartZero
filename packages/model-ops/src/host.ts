/**
 * What the agent's op tools and the MCP server need from whoever holds the document: an
 * {@link OpsHost}. The app implements it over its command registry (the live document: every op
 * the agent issues is a command the user sees land); {@link MemoryOpsHost} holds a document in
 * memory (headless MCP, evals, tests) with the same transactions, checks and undo.
 */
import type { metricsV1 } from "@aicad/ir-types";
import { EMPTY_HOST_STATE, type HostState, type OpOrigin } from "./apply.js";
import type { IrOp } from "./catalogue.js";
import { opLabel } from "./catalogue.js";
import { requireCommandEngine, type IrCommandEngine } from "./engine.js";
import type { Approvals, NewFailure } from "./rules.js";
import { runTransaction, type TransactionResult } from "./transaction.js";

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
  /** Acknowledged newly failing features (the ids a `COMMAND_NEW_FAILURES` refusal listed). */
  ack?: readonly string[];
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
  private readonly ownParams = new Set<string>();
  private readonly listeners = new Set<(c: OpsCommit & { document: string }) => void>();

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
          approvals: {
            features: [...(this.options.approvals?.features ?? [])],
            // Parameters have no author (ADR 0015 §2): those this session added are its own to change.
            params: [...(this.options.approvals?.params ?? []), ...this.ownParams],
          },
        },
        ops,
      );
      if (t.changed) {
        this.undoStack.push(this.current);
        this.redoStack.length = 0;
        this.current = { document: t.document, host: t.host, label };
        this.revision++;
        for (const o of t.ops) {
          if (o.op.op === "addParam") this.ownParams.add(o.op.name);
          if (o.op.op === "renameParam" && this.ownParams.delete(o.op.old)) this.ownParams.add(o.op.new);
        }
      }
      const c = commitSummary(label, this.revision, t);
      if (t.changed) for (const l of [...this.listeners]) l({ ...c, document: t.document });
      return c;
    });
    this.queue = run.catch(() => undefined);
    return run;
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

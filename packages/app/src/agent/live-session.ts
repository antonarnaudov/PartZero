/**
 * One live agent turn on the open document (the `ops` surface): the renderer's side of the live
 * operator. The agent process sends its ops here (`agent:ops`); every one is applied through the
 * app's command registry **as the agent** (`ir.apply` with source `agent`, via `appOpsHost`), inside
 * the turn's undo group, so it lands in the viewport and the timeline at once, authored `agent`
 * (ADR 0015), refused by the same checks as any other caller.
 *
 * - **One undo step per turn:** the session opens an undo group (`ir.openGroup`) before the run
 *   starts and seals it when the run ends — whether it finished, failed or the user pressed Stop —
 *   so everything built stays and one Undo takes the whole turn back. A run that broke its CLI
 *   lockdown is the exception: its group is aborted (nothing it did is kept).
 * - **Approvals:** when the user allows the agent's request to change their work, the session
 *   records it on the store for this group only (`IrDocStore.approveForGroup`): host code, never a
 *   command, so no agent or MCP client can grant itself anything.
 * - Undo from the agent (Ask at each step) runs `ir.undo` as the agent: the command allows it only
 *   inside the agent's own open group.
 */
import type { IrOp, OpsCommit } from "@aicad/model-ops";
import { CommandEngineError } from "@aicad/model-ops";
import type { AgentApprovalRequest, AgentOpsReply, AgentOpsRequest } from "../agent-protocol";
import type { AppCommandRegistry } from "../commands/commands";
import type { AppServices } from "../services";
import { appOpsHost } from "./ops-host";

export interface LiveSessionEnv {
  services: AppServices;
  commands: AppCommandRegistry;
}

function errorOf(e: unknown): Extract<AgentOpsReply, { ok: false }>["error"] {
  if (e instanceof CommandEngineError) return { code: e.code, message: e.message, ...(e.errors.length ? { errors: e.errors } : {}), ...(Object.keys(e.details).length ? { details: e.details } : {}) };
  const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  return { code: typeof o["code"] === "string" ? o["code"] : "FAILED", message: e instanceof Error ? e.message : String(e) };
}

export class LiveSession {
  readonly label: string;
  readonly token: string;
  /** Set once the start reply names the run (ops may arrive before it: they wait). */
  runId: string | null = null;
  #closed = false;
  readonly #env: LiveSessionEnv;
  readonly #early: AgentOpsRequest[] = [];
  readonly #reply: (r: AgentOpsReply) => void;

  private constructor(env: LiveSessionEnv, label: string, token: string, reply: (r: AgentOpsReply) => void) {
    this.#env = env;
    this.label = label;
    this.token = token;
    this.#reply = reply;
  }

  /** Open the turn's undo group (as the agent) and a session for it. */
  static async open(env: LiveSessionEnv, label: string, reply: (r: AgentOpsReply) => void): Promise<LiveSession> {
    const r = await env.commands.execute({ id: "ir.openGroup", args: { label } }, { source: "agent" });
    if (!r.ok) throw new CommandEngineError(r.error.detail?.code ?? r.error.code, r.error.message);
    return new LiveSession(env, label, (r.value as { token: string }).token, reply);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The run started: answer the ops that arrived before its id was known. */
  bind(runId: string): void {
    this.runId = runId;
    const early = this.#early.splice(0);
    for (const req of early) this.handle(req);
  }

  /** One op from the agent process; the answer goes back through `reply`. */
  handle(req: AgentOpsRequest): void {
    if (this.runId === null && !this.#closed) {
      if (this.#early.length < 100) this.#early.push(req);
      return;
    }
    if (this.#closed || req.runId !== this.runId) {
      this.#reply({ v: 1, runId: req.runId, id: req.id, ok: false, error: { code: "IR_GROUP_CLOSED", message: "this agent turn has ended in the app" } });
      return;
    }
    void this.#run(req).then(
      (value) => this.#reply({ v: 1, runId: req.runId, id: req.id, ok: true, value }),
      (e: unknown) => this.#reply({ v: 1, runId: req.runId, id: req.id, ok: false, error: errorOf(e) }),
    );
  }

  async #run(req: AgentOpsRequest): Promise<unknown> {
    const { services, commands } = this.#env;
    const host = appOpsHost(services, commands, "agent");
    switch (req.method) {
      case "document":
        return host.document();
      case "hostState":
        return host.hostState();
      case "apply": {
        const ops = (req.ops ?? []) as IrOp[];
        const c: OpsCommit = await host.apply(ops, { ...(req.options?.label ? { label: req.options.label } : {}), ...(req.options?.ack ? { ack: req.options.ack } : {}), group: this.token });
        return c;
      }
      case "undo": {
        const r = await commands.execute({ id: "ir.undo", args: {} }, { source: "agent" });
        if (!r.ok) throw new CommandEngineError(r.error.detail?.code ?? r.error.code, r.error.message);
        await services.doc.idle();
        return (r.value as { undone: boolean }).undone;
      }
    }
  }

  /** The user allowed the agent's request (their answer): recorded for this turn's group only. */
  approve(request: AgentApprovalRequest): void {
    this.#env.services.ir?.approveForGroup(this.token, { features: request.features, params: request.params, ...(request.rollback ? { rollback: true } : {}) });
  }

  /**
   * End the turn: seal the group (everything built stays, as one undo step) or abort it (a run
   * that broke its lockdown). Idempotent. Ops that arrive later are refused.
   */
  async close(kind: "seal" | "abort" = "seal"): Promise<{ changed: boolean; steps: number }> {
    if (this.#closed) return { changed: false, steps: 0 };
    this.#closed = true;
    for (const req of this.#early.splice(0)) this.#reply({ v: 1, runId: req.runId, id: req.id, ok: false, error: { code: "IR_GROUP_CLOSED", message: "this agent turn has ended in the app" } });
    const ir = this.#env.services.ir;
    if (!ir || ir.getState().group === null) return { changed: false, steps: 0 };
    const steps = ir.getState().group?.steps ?? 0;
    try {
      if (kind === "abort") {
        await ir.abortGroup(this.token);
        return { changed: false, steps };
      }
      const r = await ir.sealGroup(this.token);
      await this.#env.services.doc.idle();
      return { changed: r.changed, steps: r.steps };
    } catch {
      // The group was already closed (a document was opened over it): nothing to do.
      return { changed: false, steps: 0 };
    }
  }
}

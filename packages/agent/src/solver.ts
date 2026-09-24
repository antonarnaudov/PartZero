/**
 * `LLMSolver`: the agent as a MakerBench solver (`@aicad/evals` `Solver`). It sees only the public
 * task (prompt, process, T4 context) — never the reference or hidden tests. For T5 tasks, eval mode
 * answers the agent's clarifying questions with the task's recorded defaults (`clarify.assumptions`),
 * which play the user.
 *
 * CLI agents (ADR 0014) work unchanged: pass CLI profile ids in `models` (the gateway must have the
 * CLI adapters and transports, `@aicad/llm-gateway/cli`), and `agent.runtime` (`CliAgentRuntime`)
 * for runtime mode. Subscription costs are notional; each record says how the designer ran.
 */
import type { Billing, LLMGateway } from "@aicad/llm-gateway";
import type { Engine, LoadedTask, PublicTask, Solver, SolverOutput } from "@aicad/evals";
import { Agent, type AgentOptions, type AgentResult } from "./agent.js";
import { resolveModels, type ModelOverrides } from "./models.js";

export interface LLMSolverOptions {
  gateway: LLMGateway;
  engine: Engine;
  models?: ModelOverrides;
  /** USD cap per task (default 1.5). */
  budgetUsd?: number;
  /** Loaded tasks, used only for the recorded clarification defaults of T5 tasks. */
  tasks?: readonly LoadedTask[];
  /** Extra agent options (limits, hooks, prompt version, …). */
  agent?: Partial<Omit<AgentOptions, "gateway" | "engine" | "models" | "budgetUsd">>;
  /** Solver name in results (default `agent:<designer model>`). */
  name?: string;
  /** Keep full conversations in the transcript (large). */
  keepConversations?: boolean;
}

/** What the bench keeps per task, beyond the pipeline's TaskResult. */
export interface AgentRunRecord {
  status: AgentResult["status"];
  stopReason: AgentResult["stopReason"];
  costUsd: number;
  latencyMs: number;
  turns: number;
  applies: number;
  failedApplies: number;
  repairs: number;
  replans: number;
  specTests?: { passed: number; total: number };
  /** How the designer's model calls ran: API/local through the gateway, or a CLI agent (completion or runtime). */
  mode: "gateway" | "cli-completion" | "cli-runtime";
  /** Who paid (the designer's profile): `subscription` costs are notional. */
  billing: Billing;
}


export class LLMSolver implements Solver {
  readonly name: string;
  readonly runs = new Map<string, AgentRunRecord>();
  readonly #o: LLMSolverOptions;
  readonly #defaults = new Map<string, string>();

  constructor(options: LLMSolverOptions) {
    this.#o = options;
    const designer = resolveModels(options.gateway, options.models).designer.model;
    this.name = options.name ?? `agent:${designer}`;
    for (const t of options.tasks ?? []) if (t.clarify) this.#defaults.set(t.id, t.clarify.assumptions);
  }

  async solve(task: PublicTask): Promise<SolverOutput> {
    const o = this.#o;
    const agent = new Agent({
      ...o.agent,
      gateway: o.gateway,
      engine: o.engine,
      ...(o.models ? { models: o.models } : {}),
      budgetUsd: o.budgetUsd ?? 1.5,
      mode: "eval",
      recordedDefaults: this.#defaults.get(task.id),
      taskId: `makerbench:${task.id}`,
    });
    const r = await agent.run({ prompt: task.prompt, context: task.context, name: task.id, process: task.process });
    const record: AgentRunRecord = {
      status: r.status,
      stopReason: r.stopReason,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      turns: r.turns,
      applies: r.trace.applies,
      failedApplies: r.trace.failedApplies,
      repairs: r.trace.repairs,
      replans: r.trace.replans,
      mode: r.mode,
      billing: r.billing,
    };
    if (r.tests) record.specTests = { passed: r.tests.filter((t) => t.pass).length, total: r.tests.length };
    this.runs.set(task.id, record);
    return {
      cadscript: r.cadscript,
      costUsd: r.costUsd,
      billing: r.billing,
      latencyMs: r.latencyMs,
      transcript: {
        ...record,
        message: r.message,
        triage: r.triage,
        clarifications: r.clarifications,
        spec: r.spec,
        proposal: r.proposal,
        models: r.models,
        prompts: r.prompts,
        trace: r.trace,
        events: r.events,
        ...(o.keepConversations ? { conversations: r.conversations } : {}),
      },
    };
  }
}

/**
 * Shared plumbing for one agent run: the gateway task (USD cap + ledger), the models per role, the
 * trace, and `callModel`, which turns gateway failures into typed stops.
 */
import { BudgetExceededError, GatewayError, type ChatRequest, type ChatResponse, type LLMGateway, type Task } from "@aicad/llm-gateway";
import type { AgentModels, AgentRole } from "./models.js";
import type { AgentStopReason, TraceRecorder } from "./trace.js";

export interface AgentLimits {
  /** Designer model calls per task (ARCHITECTURE §6: about 40 turns). */
  maxTurns: number;
  /** Repairs of one failing step before ROLLBACK+REPLAN. */
  maxRepairs: number;
  /** Rollback-and-replan rounds before stopping. */
  maxReplans: number;
  /** Rejected proposals while spec tests (or the L5 judge) fail. */
  maxRefines: number;
  /** Stop (or ask to continue) once this fraction of the budget is spent. */
  budgetStopFraction: number;
  /** Spec writer turns. */
  maxSpecTurns: number;
  /** Consecutive designer turns without a tool call before stopping. */
  maxNudges: number;
  /** ask_user rounds during the build (CLARIFY is separate). */
  maxAskRounds: number;
  /** Output tokens assumed when projecting a call's cost against the budget. */
  projectionOutputTokens: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxTurns: 40,
  maxRepairs: 2,
  maxReplans: 1,
  maxRefines: 2,
  budgetStopFraction: 0.8,
  maxSpecTurns: 5,
  maxNudges: 2,
  maxAskRounds: 1,
  projectionOutputTokens: 6000,
};

/** A typed stop: the orchestrator ends the run with this reason. */
export class AgentStop extends Error {
  readonly reason: AgentStopReason;
  constructor(reason: AgentStopReason, message: string) {
    super(message);
    this.name = "AgentStop";
    this.reason = reason;
  }
}

export interface RunContext {
  gateway: LLMGateway;
  task: Task;
  models: AgentModels;
  trace: TraceRecorder;
  limits: AgentLimits;
  now: () => number;
  /** Aborts the run: checked before every model call and passed to the provider request. */
  signal?: AbortSignal | undefined;
}

/** Throw the `cancelled` stop when the run's signal has been aborted. */
export function throwIfCancelled(rc: Pick<RunContext, "signal">): void {
  if (rc.signal?.aborted) throw new AgentStop("cancelled", "stopped by the user");
}

/** One model call as a role: routing, budget, trace. Gateway errors become {@link AgentStop}s. */
export async function callModel(rc: RunContext, role: AgentRole, request: Omit<ChatRequest, "model" | "maxOutputTokens" | "reasoning">): Promise<ChatResponse> {
  throwIfCancelled(rc);
  const m = rc.models[role];
  const req: ChatRequest = { ...request, model: m.model };
  if (rc.signal !== undefined) req.signal = rc.signal;
  if (m.maxOutputTokens !== undefined) req.maxOutputTokens = m.maxOutputTokens;
  if (m.effort !== undefined) req.reasoning = { effort: m.effort };
  const t0 = rc.now();
  let res: ChatResponse;
  try {
    res = await rc.task.chat(req);
  } catch (e) {
    if (e instanceof BudgetExceededError) throw new AgentStop("budget", e.message);
    if (rc.signal?.aborted || (e instanceof GatewayError && e.code === "aborted" && rc.signal !== undefined)) throw new AgentStop("cancelled", "stopped by the user");
    if (e instanceof GatewayError) throw new AgentStop("model_error", `${role} call failed (${e.code}): ${e.message}`);
    throw e;
  }
  rc.trace.llm({
    role,
    phase: rc.trace.state,
    model: m.model,
    costUsd: res.costUsd,
    usage: res.usage,
    latencyMs: Math.round(rc.now() - t0),
    stopReason: res.stopReason,
    toolCalls: res.message.content.flatMap((b) => (b.type === "tool_use" ? [b.name] : [])),
  });
  if (res.stopReason === "refusal") {
    throw new AgentStop("refusal", `${role} refused${res.refusal?.category ? ` (${res.refusal.category})` : ""}${res.refusal?.explanation ? `: ${res.refusal.explanation}` : ""}; not retried`);
  }
  return res;
}

/** The text blocks of a response, joined. */
export function responseText(res: ChatResponse): string {
  return res.message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
}

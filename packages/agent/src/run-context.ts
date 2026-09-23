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
  /** Failed applies per task, whatever happens in between (verified steps, rollbacks), before stopping. */
  maxFailedApplies: number;
  /**
   * How often one error signature may occur in a task before it stops as `same_error`. The same
   * error twice in a row always stops; rollbacks and verified steps in between do not reset this.
   */
  maxErrorRepeats: number;
  /**
   * The budget is a hard cap: every call is projected (and reserved) with the output-token ceiling
   * it is sent with. When the remaining budget cannot pay for a role's full ceiling, the call is
   * sent with fewer output tokens, but never fewer than this (then it is refused as over budget).
   */
  minOutputTokens: number;
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
  maxFailedApplies: 10,
  maxErrorRepeats: 2,
  minOutputTokens: 1024,
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
  /** Runs before every model call of every phase (the orchestrator's 80 % budget gate). */
  beforeCall?: ((role: AgentRole) => Promise<void>) | undefined;
}

/** Throw the `cancelled` stop when the run's signal has been aborted. */
export function throwIfCancelled(rc: Pick<RunContext, "signal">): void {
  if (rc.signal?.aborted) throw new AgentStop("cancelled", "stopped by the user");
}

/**
 * The output-token ceiling for a call: the role's ceiling, or less when the remaining budget cannot
 * pay for it. The gateway reserves the call's projection at exactly this ceiling, so what the call
 * can cost never exceeds the cap (the old fixed 6000-token projection let a 16k-token designer turn
 * overshoot it).
 */
export function affordableOutputTokens(rc: RunContext, req: ChatRequest, ceiling: number): { maxOutputTokens: number; clamped: boolean } {
  const remaining = rc.task.budget.remainingUsd;
  const full = rc.gateway.project(req, ceiling).projectedUsd;
  if (full <= remaining) return { maxOutputTokens: ceiling, clamped: false };
  const base = rc.gateway.project(req, 0).projectedUsd;
  const perToken = (full - base) / ceiling;
  // One token of slack for floating-point rounding in the gateway's own check.
  const fit = perToken > 0 ? Math.floor((remaining - base) / perToken) - 1 : ceiling;
  const floor = Math.min(ceiling, rc.limits.minOutputTokens);
  return { maxOutputTokens: Math.max(floor, Math.min(ceiling, fit)), clamped: true };
}

/** One model call as a role: routing, budget, trace. Gateway errors become {@link AgentStop}s. */
export async function callModel(rc: RunContext, role: AgentRole, request: Omit<ChatRequest, "model" | "maxOutputTokens" | "reasoning">): Promise<ChatResponse> {
  throwIfCancelled(rc);
  await rc.beforeCall?.(role);
  const m = rc.models[role];
  const req: ChatRequest = { ...request, model: m.model };
  if (rc.signal !== undefined) req.signal = rc.signal;
  if (m.effort !== undefined) req.reasoning = { effort: m.effort };
  const profile = rc.gateway.profile(m.model);
  const ceiling = Math.max(1, Math.min(m.maxOutputTokens ?? profile.defaultMaxOutputTokens, profile.maxOutputTokens));
  const out = affordableOutputTokens(rc, req, ceiling);
  req.maxOutputTokens = out.maxOutputTokens;
  if (out.clamped) rc.trace.note(`${role}: output ceiling ${ceiling} → ${out.maxOutputTokens} tokens to stay within the $${rc.task.budget.capUsd.toFixed(2)} cap`);
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

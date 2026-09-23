/**
 * The agent's trace: every state transition, model call (with cost, tokens, latency) and tool call,
 * plus a summary for reports (cost per role, turns, repairs, replans, stop reason).
 */
import type { StopReason as ModelStopReason, Usage } from "@aicad/llm-gateway";
import type { AgentRole } from "./models.js";

export type AgentState = "TRIAGE" | "ASK" | "CLARIFY" | "SPEC" | "BUILD" | "REPAIR" | "REPLAN" | "PROPOSE" | "DONE";

export type AgentStopReason =
  | "proposed"
  | "answered"
  | "same_error"
  | "repairs_exhausted"
  | "budget"
  | "max_turns"
  | "refusal"
  | "no_progress"
  | "engine_unavailable"
  | "model_error";

export interface LlmCallRecord {
  role: AgentRole;
  /** `clarify` calls are designer calls in their own short conversation. */
  phase: AgentState;
  model: string;
  costUsd: number;
  usage: Usage;
  latencyMs: number;
  stopReason: ModelStopReason;
  toolCalls: string[];
}

export interface ToolCallRecord {
  name: string;
  ok: boolean;
  ms: number;
  phase: AgentState;
}

export interface TraceEvent {
  /** Milliseconds since the run started. */
  t: number;
  state: AgentState;
  type: "state" | "llm" | "tool" | "note" | "stop";
  text: string;
}

export interface TraceSummary {
  costUsd: number;
  costByRole: Record<AgentRole, number>;
  latencyMs: number;
  /** Designer model calls (BUILD/REPAIR/REPLAN/CLARIFY/ASK). */
  turns: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: Record<string, number>;
  applies: number;
  failedApplies: number;
  repairs: number;
  replans: number;
  refines: number;
  states: AgentState[];
  stopReason?: AgentStopReason;
}

export class TraceRecorder {
  readonly events: TraceEvent[] = [];
  readonly llmCalls: LlmCallRecord[] = [];
  readonly toolCalls: ToolCallRecord[] = [];
  readonly states: AgentState[] = [];
  applies = 0;
  failedApplies = 0;
  repairs = 0;
  replans = 0;
  refines = 0;
  stopReason: AgentStopReason | undefined;
  state: AgentState = "TRIAGE";
  readonly #start: number;
  readonly #now: () => number;
  readonly #onEvent: ((e: TraceEvent) => void) | undefined;

  constructor(now: () => number = () => performance.now(), onEvent?: (e: TraceEvent) => void) {
    this.#now = now;
    this.#start = now();
    this.#onEvent = onEvent;
  }

  elapsed(): number {
    return Math.round(this.#now() - this.#start);
  }

  #push(type: TraceEvent["type"], text: string): void {
    const e: TraceEvent = { t: this.elapsed(), state: this.state, type, text };
    this.events.push(e);
    this.#onEvent?.(e);
  }

  enter(state: AgentState, why = ""): void {
    this.state = state;
    if (this.states[this.states.length - 1] !== state) this.states.push(state);
    this.#push("state", why ? `${state}: ${why}` : state);
  }

  llm(r: LlmCallRecord): void {
    this.llmCalls.push(r);
    this.#push("llm", `${r.role} ${r.model} $${r.costUsd.toFixed(4)} in ${r.usage.inputTokens}+${r.usage.cacheReadTokens}c out ${r.usage.outputTokens} ${r.stopReason}${r.toolCalls.length ? ` → ${r.toolCalls.join(", ")}` : ""}`);
  }

  tool(r: ToolCallRecord, text: string): void {
    this.toolCalls.push(r);
    this.#push("tool", `${r.name} ${r.ok ? "ok" : "ERROR"}: ${text}`);
  }

  note(text: string): void {
    this.#push("note", text);
  }

  stop(reason: AgentStopReason, text: string): void {
    this.stopReason = reason;
    this.#push("stop", `${reason}: ${text}`);
  }

  summary(): TraceSummary {
    const costByRole: Record<AgentRole, number> = { triage: 0, designer: 0, spec_writer: 0 };
    const tools: Record<string, number> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    for (const c of this.llmCalls) {
      costByRole[c.role] += c.costUsd;
      inputTokens += c.usage.inputTokens;
      outputTokens += c.usage.outputTokens;
      cacheRead += c.usage.cacheReadTokens;
      cacheWrite += c.usage.cacheWriteTokens;
    }
    for (const t of this.toolCalls) tools[t.name] = (tools[t.name] ?? 0) + 1;
    const s: TraceSummary = {
      costUsd: this.llmCalls.reduce((n, c) => n + c.costUsd, 0),
      costByRole,
      latencyMs: this.elapsed(),
      turns: this.llmCalls.filter((c) => c.role === "designer").length,
      llmCalls: this.llmCalls.length,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      toolCalls: Object.fromEntries(Object.entries(tools).sort(([a], [b]) => (a < b ? -1 : 1))),
      applies: this.applies,
      failedApplies: this.failedApplies,
      repairs: this.repairs,
      replans: this.replans,
      refines: this.refines,
      states: [...this.states],
    };
    if (this.stopReason !== undefined) s.stopReason = this.stopReason;
    return s;
  }
}

/** A human-readable multi-line trace summary (CLI output). */
export function formatTraceSummary(s: TraceSummary, extra: { status?: string; tests?: string } = {}): string {
  const usd = (x: number) => `$${x.toFixed(4)}`;
  const lines = [
    `status: ${extra.status ?? "?"}${s.stopReason ? ` (${s.stopReason})` : ""}`,
    `states: ${s.states.join(" → ")}`,
    `cost: ${usd(s.costUsd)} (designer ${usd(s.costByRole.designer)}, spec writer ${usd(s.costByRole.spec_writer)}, triage ${usd(s.costByRole.triage)})`,
    `latency: ${(s.latencyMs / 1000).toFixed(1)} s, model calls: ${s.llmCalls}, designer turns: ${s.turns}`,
    `tokens: in ${s.inputTokens} (+${s.cacheReadTokens} cache read, ${s.cacheWriteTokens} cache write), out ${s.outputTokens}`,
    `applies: ${s.applies} (${s.failedApplies} failed), repairs ${s.repairs}, replans ${s.replans}, refines ${s.refines}`,
    `tools: ${Object.entries(s.toolCalls).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`,
  ];
  if (extra.tests) lines.push(`spec tests: ${extra.tests}`);
  return lines.join("\n");
}

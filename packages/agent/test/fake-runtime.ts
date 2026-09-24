/**
 * An in-process `AgentRuntime` for orchestrator tests: it plays scripted CLI turns against the real
 * `AgentRun` handler (no process, no broker), with the broker's close semantics (§6.5): after a
 * result carries `close`, every further call gets the closed text and does not reach the handler.
 * The end-to-end path (real CLI driver, shim and broker) is covered by cli-runtime.test.ts.
 */
import { BUILTIN_CLI_PROFILES, BUILTIN_PROFILES, computeCostUsd, emptyUsage, type CliFailure, type Message, type ModelProfile, type StopReason, type Usage } from "@aicad/llm-gateway";
import type { AgentRuntime, RuntimeEndedBy, RuntimePhase, RuntimePhaseOutcome, RuntimePhaseSpec, RuntimeToolResult } from "../src/index.js";

export const CLI_TEST_PROFILES: readonly ModelProfile[] = [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES];

/** One model message inside a CLI turn. */
export interface FakeMessage {
  text?: string;
  calls?: Array<{ name: string; input: Record<string, unknown> }>;
  usage?: { input?: number; output?: number };
  stop?: StopReason;
  /** After this message's turn: a CLI result corrects the phase's estimates by this much (`onCostCorrection`). */
  correctUsd?: number;
}

export interface FakePhase {
  /** CLI turns: turn 0 answers the first prompt, turn i answers the i-th continuation message. */
  turns: FakeMessage[][];
  /** End the phase this way after the scripted turns (default: as the calls and decisions imply). */
  endWith?: { endedBy: RuntimeEndedBy; failure?: CliFailure };
  /** CLI-reported cost (settled instead of the estimates). */
  reportedCostUsd?: number;
}

export interface FakeCall {
  phase: RuntimePhase;
  name: string;
  /** Reached the handler (false: answered with the closed text). */
  handled: boolean;
  result: RuntimeToolResult;
}

const CLOSED = (reason: string, tag: string | undefined) => `${tag ?? ""} The task has ended (${reason}). Do not call any more tools; reply with one short line.`.trim();

export class FakeRuntime implements AgentRuntime {
  readonly kind = "cli" as const;
  readonly specs: RuntimePhaseSpec[] = [];
  readonly calls: FakeCall[] = [];
  /** Continuation messages the orchestrator sent, per phase. */
  readonly continuations: Array<{ phase: RuntimePhase; message: string }> = [];
  readonly #script: Partial<Record<RuntimePhase, FakePhase>>;
  readonly #supports: boolean;

  constructor(script: Partial<Record<RuntimePhase, FakePhase>>, options: { supports?: boolean } = {}) {
    this.#script = script;
    this.#supports = options.supports ?? true;
  }

  supports(profile: ModelProfile): boolean {
    return this.#supports && profile.cli !== undefined;
  }

  async runPhase(spec: RuntimePhaseSpec): Promise<RuntimePhaseOutcome> {
    this.specs.push(spec);
    const script = this.#script[spec.phase];
    if (script === undefined) throw new Error(`FakeRuntime: no script for ${spec.phase}`);
    let closeReason: string | null = null;
    let endedBy: RuntimeEndedBy | null = null;
    let turns = 0;
    let toolCalls = 0;
    let seq = 0;
    let estimate = 0;
    let finalText = "";
    const usageTotal: Usage = emptyUsage();
    const transcript: Message[] = [{ role: "user", content: [{ type: "text", text: spec.prompt }] }];
    for (let t = 0; t < script.turns.length && endedBy === null; t++) {
      for (const msg of script.turns[t]!) {
        const usage: Usage = { ...emptyUsage(), inputTokens: msg.usage?.input ?? 1000, outputTokens: msg.usage?.output ?? 100 };
        const cost = computeCostUsd(spec.profile, usage);
        estimate += cost;
        usageTotal.inputTokens += usage.inputTokens;
        usageTotal.outputTokens += usage.outputTokens;
        turns++;
        transcript.push({
          role: "assistant",
          content: [...(msg.text ? [{ type: "text" as const, text: msg.text }] : []), ...(msg.calls ?? []).map((c, i) => ({ type: "tool_use" as const, id: `f${t}_${i}`, name: c.name, input: c.input }))],
        });
        spec.onModelTurn({ model: "fake-model", usage, costUsd: cost, toolCalls: (msg.calls ?? []).map((c) => c.name), stopReason: msg.stop ?? ((msg.calls ?? []).length > 0 ? "tool_use" : "end_turn"), latencyMs: 5 });
        if (msg.correctUsd !== undefined) spec.onCostCorrection?.(msg.correctUsd);
        if (msg.stop === "refusal") {
          endedBy = "refusal";
          break;
        }
        if (msg.text !== undefined && (msg.calls ?? []).length === 0) finalText = msg.text;
        for (const c of msg.calls ?? []) {
          toolCalls++;
          seq++;
          if (closeReason !== null) {
            this.calls.push({ phase: spec.phase, name: c.name, handled: false, result: { text: CLOSED(closeReason, spec.orchTag), isError: true } });
            continue;
          }
          const r = await spec.handleToolCall({ seq, name: c.name, input: c.input, toolUseId: `toolu_${seq}` });
          this.calls.push({ phase: spec.phase, name: c.name, handled: true, result: r });
          if (r.close) {
            closeReason = r.close;
            endedBy = "closed";
          }
        }
      }
      if (endedBy !== null) break;
      const decision = await spec.onTurnEnd({ finalText, turns });
      if (decision.action === "finish") {
        endedBy = "cli_end";
        break;
      }
      this.continuations.push({ phase: spec.phase, message: decision.message });
      transcript.push({ role: "user", content: [{ type: "text", text: decision.message }] });
    }
    if (script.endWith) endedBy = script.endWith.endedBy;
    const reported = script.reportedCostUsd;
    return {
      endedBy: endedBy ?? "cli_end",
      closeReason,
      finalText,
      turns,
      toolCalls,
      usage: usageTotal,
      costUsd: reported ?? estimate,
      costSource: reported !== undefined ? "provider" : "profile",
      billing: spec.profile.billing,
      sessionId: `fake-${spec.phase.toLowerCase()}`,
      modelsUsed: ["fake-model"],
      planUsage: null,
      failure: script.endWith?.failure ?? null,
      transcript,
      cli: { provider: "claude-cli", version: "2.1.260", lockdown: "verified" },
    };
  }
}

import type { PlanUsage, StopReason, Usage } from "../types.js";
import type { CliFailure } from "./provider.js";

/**
 * Normalized CLI events (docs/CLI-PROVIDERS.md §7.5, frozen). Every CLI dialect is parsed into these by its
 * provider's `parseEvents`; nothing outside the provider files knows a CLI's native event shapes.
 */
export type CliEvent =
  | {
      type: "init";
      sessionId: string | null;
      model: string | null;
      version: string | null;
      /** Tool list the model will see, when the CLI reports it before the first model call (Claude only). */
      tools: readonly string[] | null;
      mcpServers: ReadonlyArray<{ name: string; status: string }> | null;
    }
  | { type: "text"; messageId: string | null; text: string; delta: boolean }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; callId: string; qualifiedName: string; server: string | null; tool: string; input: unknown }
  | {
      type: "tool_result";
      callId: string;
      isError: boolean;
      text: string;
      /**
       * (additive, §5.6 amendment) The CLI itself refused the call because it has no tool of that name (Gemini
       * `error.type: "tool_not_registered"`, opencode "Model tried to call unavailable tool"). Nothing ran.
       */
      unavailable?: true;
    }
  | { type: "structured"; value: unknown }
  | { type: "turn"; messageId: string | null; model: string | null; usage: Usage | null; stopReason: StopReason | null }
  | { type: "plan_usage"; usage: PlanUsage }
  | { type: "retry"; attempt: number | null; message: string }
  | { type: "warning"; message: string }
  | { type: "refusal"; message: string }
  | CliResultEvent;

export interface CliResultEvent {
  type: "result";
  ok: boolean;
  /** CLI-native ("success", "error_max_turns", "turn.failed", "exit"). */
  subtype: string;
  /** Final assistant text of the last turn. */
  text: string;
  sessionId: string | null;
  turns: number | null;
  /** Invocation totals. */
  usage: Usage | null;
  /** CLI-reported USD (notional for subscriptions). */
  costUsd: number | null;
  models: readonly string[];
  failure: CliFailure | null;
}

/**
 * (additive) The final assistant text of one invocation, the single rule for the transport and the adapter: the last
 * `result` text when it is non-empty, else the `text` events after the last tool activity (`tool_call` /
 * `tool_result`). `turn` events do not reset it: Gemini emits its `turn` after the text of that turn.
 */
export function finalAssistantText(events: readonly CliEvent[]): string | null {
  let result: CliResultEvent | null = null;
  for (const e of events) if (e.type === "result") result = e;
  if (result !== null && result.text.length > 0) return result.text;
  let texts: string[] = [];
  for (const e of events) {
    if (e.type === "tool_call" || e.type === "tool_result") texts = [];
    else if (e.type === "text") texts.push(e.text);
  }
  return texts.length > 0 ? texts.join("") : null;
}

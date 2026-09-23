/**
 * Offline model scripting for tests, CI and dry runs: a `ProviderTransport` that plays scripted
 * turns as genuine Anthropic Messages API stream events, so every call still goes through the real
 * gateway (adapter, pricing, budget, ledger) and the real orchestrator.
 *
 * Calls are routed to a script by the tools they offer: `classify` → triage, `submit_spec` →
 * spec writer, `apply_cadscript` → designer. A step is a fixed turn or a function of the call (to
 * react to tool results, e.g. assert that a repair hint arrived before sending the fix). Like a real
 * provider, a turn whose scripted output exceeds the request's `max_tokens` is cut off there: it is
 * billed at `max_tokens` and ends with stop reason `max_tokens`.
 */
import type { ProviderTransport, TransportCall } from "@aicad/llm-gateway";
import { LLMGateway, type GatewayOptions } from "@aicad/llm-gateway";

export type ScriptRole = "triage" | "spec_writer" | "designer";

export interface ScriptTurn {
  text?: string;
  tools?: { name: string; input: Record<string, unknown>; id?: string }[];
  /** Default: `tool_use` when there are tools, else `end_turn`. */
  stop?: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  refusal?: { category: string; explanation: string };
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface ScriptedCall {
  role: ScriptRole;
  /** Index of this call within its role's script. */
  index: number;
  payload: Record<string, unknown>;
  /** Tool results in the last user message: `{ id, content, isError }`. */
  toolResults: { id: string; content: string; isError: boolean }[];
  /** Text blocks of the last user message (orchestrator notes, headers). */
  userText: string;
  /** All user-visible text of the request (system + messages), for isolation checks. */
  allText: string;
}

export type ScriptStep = ScriptTurn | ((call: ScriptedCall) => ScriptTurn);

export type Scripts = Partial<Record<ScriptRole, ScriptStep[]>>;

type Json = Record<string, unknown>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "object" && b !== null && typeof (b as Json)["text"] === "string" ? String((b as Json)["text"]) : "")).join("\n");
  return "";
}

function roleOf(payload: Json): ScriptRole {
  const names = ((payload["tools"] as Json[] | undefined) ?? []).map((t) => String(t["name"]));
  if (names.includes("classify")) return "triage";
  if (names.includes("submit_spec")) return "spec_writer";
  if (names.includes("apply_cadscript")) return "designer";
  throw new Error(`ScriptedTransport: cannot tell the role of a call with tools [${names.join(", ")}]`);
}

export function describeCall(payload: Json, role: ScriptRole, index: number): ScriptedCall {
  const messages = (payload["messages"] as Json[] | undefined) ?? [];
  const last = messages[messages.length - 1];
  const blocks = Array.isArray(last?.["content"]) ? (last!["content"] as Json[]) : [];
  const toolResults = blocks
    .filter((b) => b["type"] === "tool_result")
    .map((b) => ({ id: String(b["tool_use_id"]), content: textOf(b["content"]), isError: b["is_error"] === true }));
  const userText = blocks
    .filter((b) => b["type"] === "text")
    .map((b) => String(b["text"]))
    .join("\n");
  const system = ((payload["system"] as Json[] | undefined) ?? []).map((s) => String(s["text"])).join("\n");
  const all = messages
    .map((m) => (Array.isArray(m["content"]) ? (m["content"] as Json[]).map((b) => textOf(b["content"]) + textOf([b]) + (b["input"] ? JSON.stringify(b["input"]) : "")).join("\n") : textOf(m["content"])))
    .join("\n");
  return { role, index, payload, toolResults, userText, allText: `${system}\n${all}` };
}

let idCounter = 0;

function events(turn: ScriptTurn, model: string, n: number, maxTokens: number | undefined): unknown[] {
  const usage = turn.usage ?? {};
  const input = usage.input ?? 1500;
  // A provider never bills (or emits) more output than the request's max_tokens: the turn is cut off.
  const truncated = maxTokens !== undefined && (usage.output ?? 300) > maxTokens;
  const output = truncated ? maxTokens : (usage.output ?? 300);
  const out: unknown[] = [
    {
      type: "message_start",
      message: {
        id: `msg_scripted_${n}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: input, output_tokens: 1, cache_creation_input_tokens: usage.cacheWrite ?? 0, cache_read_input_tokens: usage.cacheRead ?? 0 },
      },
    },
  ];
  let index = 0;
  if (turn.text !== undefined) {
    out.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    out.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: turn.text } });
    out.push({ type: "content_block_stop", index });
    index++;
  }
  for (const t of turn.tools ?? []) {
    const id = t.id ?? `toolu_scripted_${++idCounter}`;
    out.push({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: t.name, input: {} } });
    out.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } });
    out.push({ type: "content_block_stop", index });
    index++;
  }
  const stop = truncated ? "max_tokens" : (turn.stop ?? ((turn.tools ?? []).length > 0 ? "tool_use" : "end_turn"));
  out.push({
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null, ...(stop === "refusal" ? { stop_details: { type: "refusal", ...(turn.refusal ?? { category: "cyber", explanation: "scripted refusal" }) } } : {}) },
    usage: { output_tokens: output },
  });
  out.push({ type: "message_stop" });
  return out;
}

/** A provider transport that replays scripted turns per role (Anthropic stream format). */
export class ScriptedTransport implements ProviderTransport {
  readonly calls: ScriptedCall[] = [];
  readonly #scripts: Scripts;
  readonly #cursor: Record<ScriptRole, number> = { triage: 0, spec_writer: 0, designer: 0 };
  #n = 0;

  constructor(scripts: Scripts) {
    this.#scripts = scripts;
  }

  /** Steps not yet consumed, per role (a finished test should have none left). */
  remaining(): Record<ScriptRole, number> {
    return {
      triage: (this.#scripts.triage?.length ?? 0) - this.#cursor.triage,
      spec_writer: (this.#scripts.spec_writer?.length ?? 0) - this.#cursor.spec_writer,
      designer: (this.#scripts.designer?.length ?? 0) - this.#cursor.designer,
    };
  }

  #next(call: TransportCall): { turn: ScriptTurn; model: string; maxTokens: number | undefined } {
    if (call.operation !== "anthropic.messages.create") throw new Error(`ScriptedTransport speaks the Anthropic format only (got ${call.operation})`);
    const role = roleOf(call.payload);
    const index = this.#cursor[role]++;
    const step = this.#scripts[role]?.[index];
    if (step === undefined) throw new Error(`ScriptedTransport: no scripted ${role} turn #${index + 1}`);
    const described = describeCall(call.payload, role, index);
    this.calls.push(described);
    const maxTokens = call.payload["max_tokens"];
    return { turn: typeof step === "function" ? step(described) : step, model: String(call.payload["model"]), maxTokens: typeof maxTokens === "number" ? maxTokens : undefined };
  }

  async send(): Promise<unknown> {
    throw new Error("ScriptedTransport: Anthropic profiles always stream");
  }

  async *stream(call: TransportCall): AsyncIterable<unknown> {
    const { turn, model, maxTokens } = this.#next(call);
    yield* events(turn, model, ++this.#n, maxTokens);
  }
}

/** A gateway whose Anthropic traffic is served by `transport`. */
export function scriptedGateway(transport: ProviderTransport, options: Omit<GatewayOptions, "transports"> = {}): LLMGateway {
  return new LLMGateway({ ...options, transports: { anthropic: transport } });
}

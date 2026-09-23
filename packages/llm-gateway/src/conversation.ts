import { GatewayError } from "./errors.js";
import type { AssistantMessage, ChatResponse, Message, UserContentBlock } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/**
 * Append-only message history. Appended messages are deep-frozen, so an accidental edit of an earlier turn (which
 * would invalidate the prompt cache and, on Claude Opus 5.5 / Fable 5.1, every later thinking block) throws instead
 * of silently changing the prefix. Assistant turns are stored exactly as the gateway returned them.
 */
export class Conversation {
  readonly #messages: Message[] = [];

  constructor(initial: readonly Message[] = []) {
    for (const m of initial) this.append(m);
  }

  /** A frozen snapshot; pass it (or a copy) as `ChatRequest.messages`. */
  get messages(): readonly Message[] {
    return Object.freeze([...this.#messages]);
  }

  get length(): number {
    return this.#messages.length;
  }

  append(message: Message): this {
    this.#messages.push(deepFreeze(structuredClone(message)));
    return this;
  }

  appendUser(content: UserContentBlock[] | string): this {
    return this.append({ role: "user", content: typeof content === "string" ? [{ type: "text", text: content }] : content });
  }

  /** Append the assistant turn of a response verbatim (never rebuild it from text). */
  appendResponse(response: ChatResponse): this {
    return this.appendAssistant(response.message);
  }

  appendAssistant(message: AssistantMessage): this {
    if (message.role !== "assistant") throw new GatewayError("invalid_request", "appendAssistant expects an assistant message");
    return this.append(message);
  }

  /** Tool calls in the latest assistant turn that are safe to execute (parsed input, not truncated/refused). */
  pendingToolCalls(): Array<{ id: string; name: string; input: Record<string, unknown> }> {
    const last = this.#messages.at(-1);
    if (last?.role !== "assistant") return [];
    return last.content.flatMap((b) => (b.type === "tool_use" && b.inputError === undefined ? [{ id: b.id, name: b.name, input: b.input }] : []));
  }
}

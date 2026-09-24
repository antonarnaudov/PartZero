import { GatewayError } from "../errors.js";
import type { Provider } from "../types.js";

/**
 * The boundary between adapters (pure mapping code) and the network. Adapters build the exact provider payload and
 * hand it to a transport; the transport returns the provider's raw response object or raw stream events, exactly as
 * the official SDK yields them. Swapping the transport is how tests run offline (replay) and how fixtures are captured
 * from real traffic (record).
 */
export type TransportOperation =
  | "anthropic.messages.create"
  | "openai.responses.create"
  | "google.models.generateContent"
  | "openai-compat.chat.completions.create"
  /** One stateless CLI invocation (`@aicad/llm-gateway/cli`); payload is a `CliTurnPayload`. */
  | "cli.turn"
  /** Reserved for a native Ollama `/api/chat` adapter (docs/CLI-PROVIDERS.md §10). */
  | "ollama.chat";

export interface TransportCall {
  provider: Provider;
  operation: TransportOperation;
  /** Exact request body passed to the SDK method. */
  payload: Record<string, unknown>;
  /** Endpoint discriminator for OpenAI-compatible servers (base URL). */
  endpoint?: string;
  /** Extra body fields a streaming call needs (e.g. `stream_options`); merged by the transport on `stream()`. */
  streamExtras?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProviderTransport {
  /** Non-streaming call; resolves with the provider's response object. */
  send(call: TransportCall): Promise<unknown>;
  /** Streaming call; yields the provider's raw stream events/chunks in order. */
  stream(call: TransportCall): AsyncIterable<unknown>;
}

/** A recorded exchange. Stored as JSON files under `test/fixtures`. */
export interface Fixture {
  name?: string;
  provider: Provider;
  operation: TransportOperation;
  mode: "send" | "stream";
  /** The request payload that produced this response (used for matching and as a snapshot of the mapping). */
  request: Record<string, unknown>;
  response?: unknown;
  events?: unknown[];
  /** Free text: where the response shape comes from (live capture or documented example). */
  source?: string;
}

/** Deterministic JSON (sorted keys) used for request matching. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

export interface ReplayOptions {
  /**
   * `exact`: the call's payload must equal the fixture's `request` (catches mapping drift).
   * `sequential`: fixtures are consumed in order regardless of payload (for hand-authored fixtures).
   */
  match?: "exact" | "sequential";
}

/** Serves recorded responses. Throws `replay_mismatch` when no fixture matches, so drift fails loudly. */
export class ReplayTransport implements ProviderTransport {
  readonly calls: TransportCall[] = [];
  readonly #fixtures: Fixture[];
  readonly #match: "exact" | "sequential";
  #cursor = 0;

  constructor(fixtures: Fixture[], options: ReplayOptions = {}) {
    this.#fixtures = [...fixtures];
    this.#match = options.match ?? "sequential";
  }

  #take(call: TransportCall, mode: "send" | "stream"): Fixture {
    this.calls.push(call);
    if (this.#match === "sequential") {
      const fx = this.#fixtures[this.#cursor];
      if (fx === undefined) {
        throw new GatewayError("replay_mismatch", `ReplayTransport: no fixture left for call #${this.#cursor + 1} (${call.operation})`);
      }
      if (fx.operation !== call.operation || fx.mode !== mode) {
        throw new GatewayError(
          "replay_mismatch",
          `ReplayTransport: fixture #${this.#cursor + 1} is ${fx.operation}/${fx.mode}, call is ${call.operation}/${mode}`,
        );
      }
      this.#cursor += 1;
      return fx;
    }
    const key = stableStringify(call.payload);
    const idx = this.#fixtures.findIndex((f) => f.operation === call.operation && f.mode === mode && stableStringify(f.request) === key);
    const fx = idx === -1 ? undefined : this.#fixtures[idx];
    if (fx === undefined) {
      throw new GatewayError("replay_mismatch", `ReplayTransport: no fixture matches ${call.operation}/${mode} payload`, {
        details: { payload: call.payload },
      });
    }
    this.#fixtures.splice(idx, 1);
    return fx;
  }

  async send(call: TransportCall): Promise<unknown> {
    const fx = this.#take(call, "send");
    return structuredClone(fx.response);
  }

  async *stream(call: TransportCall): AsyncIterable<unknown> {
    const fx = this.#take(call, "stream");
    for (const event of fx.events ?? []) yield structuredClone(event);
  }
}

/** JSON round-trip copy: SDK response objects can be class instances; fixtures must be plain JSON. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Wraps a real transport and captures every exchange as a {@link Fixture}. */
export class RecordingTransport implements ProviderTransport {
  readonly fixtures: Fixture[] = [];
  readonly #inner: ProviderTransport;

  constructor(inner: ProviderTransport) {
    this.#inner = inner;
  }

  async send(call: TransportCall): Promise<unknown> {
    const response = await this.#inner.send(call);
    this.fixtures.push({
      provider: call.provider,
      operation: call.operation,
      mode: "send",
      request: cloneJson(call.payload),
      response: cloneJson(response),
      source: `recorded ${new Date().toISOString()}`,
    });
    return response;
  }

  async *stream(call: TransportCall): AsyncIterable<unknown> {
    const events: unknown[] = [];
    try {
      for await (const event of this.#inner.stream(call)) {
        events.push(cloneJson(event));
        yield event;
      }
    } finally {
      this.fixtures.push({
        provider: call.provider,
        operation: call.operation,
        mode: "stream",
        request: cloneJson(call.payload),
        events,
        source: `recorded ${new Date().toISOString()}`,
      });
    }
  }
}

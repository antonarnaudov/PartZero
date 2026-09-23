import type AnthropicClient from "@anthropic-ai/sdk";
import type { GenerateContentParameters, GoogleGenAI } from "@google/genai";
import type OpenAIClient from "openai";
import { normalizeProviderError } from "../errors.js";
import type { Provider } from "../types.js";
import type { ProviderTransport, TransportCall } from "./transport.js";

/**
 * Live transports backed by the official SDKs. Retries on 429/5xx/connection errors use each SDK's built-in
 * exponential backoff (`maxRetries` for Anthropic/OpenAI, `httpOptions.retryOptions` for @google/genai).
 * SDK modules are imported lazily so that, e.g., a browser worker using only Claude never loads the Gemini SDK.
 */
export interface SdkClientOptions {
  apiKey?: string;
  baseURL?: string;
  /** Retries after the first attempt (SDK built-in backoff). Default: SDK default (2 for Anthropic/OpenAI). */
  maxRetries?: number;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
}

export interface GoogleClientOptions extends SdkClientOptions {
  vertexai?: boolean;
  project?: string;
  location?: string;
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

async function* guardStream(provider: Provider, iterable: AsyncIterable<unknown>): AsyncIterable<unknown> {
  try {
    for await (const event of iterable) yield event;
  } catch (err) {
    throw normalizeProviderError(provider, err);
  }
}

export class AnthropicSdkTransport implements ProviderTransport {
  readonly #options: SdkClientOptions;
  #client: Promise<AnthropicClient> | undefined;

  constructor(options: SdkClientOptions = {}) {
    this.#options = options;
  }

  #get(): Promise<AnthropicClient> {
    this.#client ??= import("@anthropic-ai/sdk").then(({ default: Anthropic }) => {
      const o = this.#options;
      return new Anthropic({
        ...(o.apiKey === undefined ? {} : { apiKey: o.apiKey }),
        ...(o.baseURL === undefined ? {} : { baseURL: o.baseURL }),
        ...(o.maxRetries === undefined ? {} : { maxRetries: o.maxRetries }),
        ...(o.timeoutMs === undefined ? {} : { timeout: o.timeoutMs }),
        ...(o.defaultHeaders === undefined ? {} : { defaultHeaders: o.defaultHeaders }),
      });
    });
    return this.#client;
  }

  async send(call: TransportCall): Promise<unknown> {
    const client = await this.#get();
    const opts = call.signal === undefined ? {} : { signal: call.signal };
    try {
      if ("betas" in call.payload) {
        return await client.beta.messages.create(call.payload as unknown as AnthropicClient.Beta.MessageCreateParamsNonStreaming, opts);
      }
      return await client.messages.create(call.payload as unknown as AnthropicClient.MessageCreateParamsNonStreaming, opts);
    } catch (err) {
      throw normalizeProviderError("anthropic", err);
    }
  }

  async *stream(call: TransportCall): AsyncIterable<unknown> {
    const client = await this.#get();
    const opts = call.signal === undefined ? {} : { signal: call.signal };
    let stream: AsyncIterable<unknown>;
    try {
      // Raw SSE events (`stream: true`): the adapter accumulates them itself so it can replay blocks verbatim and
      // surface unparseable tool input instead of throwing mid-stream.
      stream =
        "betas" in call.payload
          ? await client.beta.messages.create(
              { ...(call.payload as unknown as AnthropicClient.Beta.MessageCreateParamsNonStreaming), stream: true },
              opts,
            )
          : await client.messages.create({ ...(call.payload as unknown as AnthropicClient.MessageCreateParamsNonStreaming), stream: true }, opts);
    } catch (err) {
      throw normalizeProviderError("anthropic", err);
    }
    yield* guardStream("anthropic", stream);
  }
}

export class OpenAISdkTransport implements ProviderTransport {
  readonly #options: SdkClientOptions;
  readonly #provider: "openai" | "openai-compat";
  #client: Promise<OpenAIClient> | undefined;

  constructor(options: SdkClientOptions = {}, provider: "openai" | "openai-compat" = "openai") {
    this.#options = options;
    this.#provider = provider;
  }

  #get(): Promise<OpenAIClient> {
    this.#client ??= import("openai").then(({ default: OpenAI }) => {
      const o = this.#options;
      // Local OpenAI-compatible servers usually need no key, but the SDK requires a non-empty string.
      const apiKey = o.apiKey ?? (this.#provider === "openai" ? env("OPENAI_API_KEY") : "not-needed");
      return new OpenAI({
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(o.baseURL === undefined ? {} : { baseURL: o.baseURL }),
        ...(o.maxRetries === undefined ? {} : { maxRetries: o.maxRetries }),
        ...(o.timeoutMs === undefined ? {} : { timeout: o.timeoutMs }),
        ...(o.defaultHeaders === undefined ? {} : { defaultHeaders: o.defaultHeaders }),
      });
    });
    return this.#client;
  }

  async send(call: TransportCall): Promise<unknown> {
    const client = await this.#get();
    const opts = call.signal === undefined ? {} : { signal: call.signal };
    try {
      if (call.operation === "openai.responses.create") {
        return await client.responses.create(call.payload as unknown as OpenAIClient.Responses.ResponseCreateParamsNonStreaming, opts);
      }
      return await client.chat.completions.create(call.payload as unknown as OpenAIClient.Chat.ChatCompletionCreateParamsNonStreaming, opts);
    } catch (err) {
      throw normalizeProviderError(this.#provider, err);
    }
  }

  async *stream(call: TransportCall): AsyncIterable<unknown> {
    const client = await this.#get();
    const opts = call.signal === undefined ? {} : { signal: call.signal };
    let stream: AsyncIterable<unknown>;
    try {
      if (call.operation === "openai.responses.create") {
        stream = await client.responses.create(
          { ...(call.payload as unknown as OpenAIClient.Responses.ResponseCreateParamsNonStreaming), ...call.streamExtras, stream: true },
          opts,
        );
      } else {
        stream = await client.chat.completions.create(
          { ...(call.payload as unknown as OpenAIClient.Chat.ChatCompletionCreateParamsNonStreaming), ...call.streamExtras, stream: true },
          opts,
        );
      }
    } catch (err) {
      throw normalizeProviderError(this.#provider, err);
    }
    yield* guardStream(this.#provider, stream);
  }
}

export class GoogleSdkTransport implements ProviderTransport {
  readonly #options: GoogleClientOptions;
  #client: Promise<GoogleGenAI> | undefined;

  constructor(options: GoogleClientOptions = {}) {
    this.#options = options;
  }

  #get(): Promise<GoogleGenAI> {
    this.#client ??= import("@google/genai").then(({ GoogleGenAI: Client }) => {
      const o = this.#options;
      const apiKey = o.apiKey ?? env("GEMINI_API_KEY");
      const httpOptions = {
        // HttpRetryOptions.attempts counts the first try; 408/429/5xx are retried by default.
        retryOptions: { attempts: (o.maxRetries ?? 2) + 1 },
        ...(o.baseURL === undefined ? {} : { baseUrl: o.baseURL }),
        ...(o.timeoutMs === undefined ? {} : { timeout: o.timeoutMs }),
        ...(o.defaultHeaders === undefined ? {} : { headers: o.defaultHeaders }),
      };
      return new Client({
        ...(o.vertexai === true ? { vertexai: true, ...(o.project === undefined ? {} : { project: o.project }), ...(o.location === undefined ? {} : { location: o.location }) } : {}),
        ...(apiKey === undefined ? {} : { apiKey }),
        httpOptions,
      });
    });
    return this.#client;
  }

  #params(call: TransportCall): GenerateContentParameters {
    const params = call.payload as unknown as GenerateContentParameters;
    if (call.signal === undefined) return params;
    return { ...params, config: { ...params.config, abortSignal: call.signal } };
  }

  async send(call: TransportCall): Promise<unknown> {
    const client = await this.#get();
    try {
      return await client.models.generateContent(this.#params(call));
    } catch (err) {
      throw normalizeProviderError("google", err);
    }
  }

  async *stream(call: TransportCall): AsyncIterable<unknown> {
    const client = await this.#get();
    let stream: AsyncIterable<unknown>;
    try {
      stream = await client.models.generateContentStream(this.#params(call));
    } catch (err) {
      throw normalizeProviderError("google", err);
    }
    yield* guardStream("google", stream);
  }
}

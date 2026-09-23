import { AnthropicAdapter } from "./adapters/anthropic.js";
import type { AdapterContext, BuiltRequest, ProviderAdapter } from "./adapters/adapter.js";
import { GoogleAdapter } from "./adapters/google.js";
import { OpenAICompatAdapter } from "./adapters/openai-compat.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { BudgetGuard, type LedgerEntry, type Reservation } from "./budget.js";
import { BUILTIN_PROFILES } from "./builtin-profiles.js";
import { loadGatewayConfigFile, parseGatewayConfig, type GatewayConfig } from "./config.js";
import { GatewayError, normalizeProviderError } from "./errors.js";
import { computeCostUsd, projectCostUsd, resolveMaxOutputTokens, type CostProjection } from "./pricing.js";
import { ProfileRegistry, type ModelProfile, type ProfileOverride } from "./profile.js";
import { DEFAULT_ROUTING, Router, type Role, type RoutingWarning } from "./router.js";
import { AnthropicSdkTransport, GoogleSdkTransport, OpenAISdkTransport } from "./transport/sdk.js";
import type { ProviderTransport, TransportCall } from "./transport/transport.js";
import type { ChatRequest, ChatResponse, Provider, StreamEvent, Usage } from "./types.js";

export interface GatewayOptions {
  /** JSON config (profile overrides, routing, provider client settings). */
  config?: GatewayConfig;
  /** Base profiles (default: built-ins). Config overrides apply on top. */
  profiles?: readonly ModelProfile[];
  /** Inject transports per provider (tests: ReplayTransport; capture: RecordingTransport). Default: official SDKs. */
  transports?: Partial<Record<Provider, ProviderTransport>>;
  /** Replace adapters (rarely needed). */
  adapters?: Partial<Record<Provider, ProviderAdapter>>;
  /** Clock for dated pricing and ledger timestamps. */
  clock?: () => Date;
  onRoutingWarning?: (w: RoutingWarning) => void;
  /** Called with every adapter warning (clamped effort, dropped foreign reasoning, ...). */
  onWarning?: (message: string, response: ChatResponse) => void;
}

export interface CallOptions {
  /** Budget to charge; the call is refused before it is issued if its projected cost does not fit. */
  budget?: BudgetGuard;
  /** Output tokens assumed by the projection. Default: the request's resolved max output tokens (worst case). */
  projectionOutputTokens?: number;
}

export interface TaskOptions {
  id: string;
  budgetUsd: number;
  /** Default output-token assumption for budget projections of this task's calls (default: worst case). */
  projectionOutputTokens?: number;
}

/** Streaming handle: iterate for events, or await `finalResponse()`. Iterable once. */
export class ChatStream implements AsyncIterable<StreamEvent> {
  readonly #gen: AsyncGenerator<StreamEvent, ChatResponse>;
  #final: ChatResponse | undefined;
  #iterated = false;

  constructor(gen: AsyncGenerator<StreamEvent, ChatResponse>) {
    this.#gen = gen;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (this.#iterated) throw new GatewayError("invalid_request", "ChatStream can only be iterated once");
    this.#iterated = true;
    for (;;) {
      const r = await this.#gen.next();
      if (r.done === true) {
        this.#final = r.value;
        return;
      }
      yield r.value;
    }
  }

  /** Consume the remaining events (if any) and return the final response. */
  async finalResponse(): Promise<ChatResponse> {
    if (this.#final !== undefined) return this.#final;
    if (!this.#iterated) {
      for await (const _event of this) {
        // drain
      }
    }
    if (this.#final === undefined) throw new GatewayError("invalid_request", "stream was not consumed to completion");
    return this.#final;
  }
}

/** A unit of agent work with its own USD cap and ledger. */
export class Task {
  readonly id: string;
  readonly budget: BudgetGuard;
  readonly #gateway: LLMGateway;
  readonly #projectionOutputTokens: number | undefined;

  constructor(gateway: LLMGateway, options: TaskOptions) {
    this.id = options.id;
    this.budget = new BudgetGuard(options.id, options.budgetUsd);
    this.#gateway = gateway;
    this.#projectionOutputTokens = options.projectionOutputTokens;
  }

  #opts(): CallOptions {
    return this.#projectionOutputTokens === undefined ? { budget: this.budget } : { budget: this.budget, projectionOutputTokens: this.#projectionOutputTokens };
  }

  chat(request: ChatRequest): Promise<ChatResponse> {
    return this.#gateway.chat(withTask(request, this.id), this.#opts());
  }

  stream(request: ChatRequest): ChatStream {
    return this.#gateway.stream(withTask(request, this.id), this.#opts());
  }

  /** Chat as a role: model, effort and max tokens come from the router. */
  chatAs(role: Role, request: Omit<ChatRequest, "model">): Promise<ChatResponse> {
    return this.chat(this.#gateway.requestFor(role, request));
  }

  streamAs(role: Role, request: Omit<ChatRequest, "model">): ChatStream {
    return this.stream(this.#gateway.requestFor(role, request));
  }

  get costUsd(): number {
    return this.budget.spentUsd;
  }

  get ledger(): readonly LedgerEntry[] {
    return this.budget.ledger;
  }
}

function withTask(request: ChatRequest, taskId: string): ChatRequest {
  return { ...request, metadata: { ...request.metadata, taskId } };
}

export class LLMGateway {
  readonly registry: ProfileRegistry;
  readonly router: Router;
  /** Every settled call, across tasks. */
  readonly ledger: LedgerEntry[] = [];
  readonly #config: ReturnType<typeof parseGatewayConfig>;
  readonly #adapters: Record<Provider, ProviderAdapter>;
  readonly #injected: Partial<Record<Provider, ProviderTransport>>;
  readonly #transports = new Map<string, ProviderTransport>();
  readonly #clock: () => Date;
  readonly #onWarning: ((message: string, response: ChatResponse) => void) | undefined;

  constructor(options: GatewayOptions = {}) {
    this.#config = parseGatewayConfig(options.config ?? {});
    this.registry = new ProfileRegistry(options.profiles ?? BUILTIN_PROFILES);
    if (this.#config.profiles !== undefined) this.registry.applyOverrides(this.#config.profiles as Record<string, ProfileOverride>);
    this.router = new Router(this.registry, this.#config.routing ?? DEFAULT_ROUTING, options.onRoutingWarning);
    this.#adapters = {
      anthropic: options.adapters?.anthropic ?? new AnthropicAdapter(),
      openai: options.adapters?.openai ?? new OpenAIAdapter(),
      google: options.adapters?.google ?? new GoogleAdapter(),
      "openai-compat": options.adapters?.["openai-compat"] ?? new OpenAICompatAdapter(),
    };
    this.#injected = options.transports ?? {};
    this.#clock = options.clock ?? (() => new Date());
    this.#onWarning = options.onWarning;
  }

  static async fromConfigFile(path: string, options: Omit<GatewayOptions, "config"> = {}): Promise<LLMGateway> {
    const config = await loadGatewayConfigFile(path);
    return new LLMGateway({ ...options, config: config as GatewayConfig });
  }

  profile(model: string): ModelProfile {
    return this.registry.get(model);
  }

  createTask(options: TaskOptions): Task {
    return new Task(this, options);
  }

  /** Total cost of all settled calls made through this gateway. */
  get totalCostUsd(): number {
    return this.ledger.reduce((sum, e) => sum + e.costUsd, 0);
  }

  /** Build a request for a role from the router (explicit fields in `request` win). */
  requestFor(role: Role, request: Omit<ChatRequest, "model">): ChatRequest {
    const route = this.router.resolve(role);
    const out: ChatRequest = { ...request, model: route.model };
    if (route.effort !== undefined && request.reasoning?.effort === undefined) out.reasoning = { ...request.reasoning, effort: route.effort };
    if (route.maxOutputTokens !== undefined && request.maxOutputTokens === undefined) out.maxOutputTokens = route.maxOutputTokens;
    return out;
  }

  /** Project the worst-case cost of a request without sending it. */
  project(request: ChatRequest, projectionOutputTokens?: number): CostProjection {
    const profile = this.registry.get(request.model);
    return projectCostUsd(request, profile, projectionOutputTokens ?? resolveMaxOutputTokens(request, profile), this.#clock());
  }

  async chat(request: ChatRequest, options: CallOptions = {}): Promise<ChatResponse> {
    const prepared = this.#prepare(request, options);
    if (!prepared.built.preferStream) return this.#send(prepared);
    const gen = this.#streamGen(prepared);
    for (;;) {
      const r = await gen.next();
      if (r.done === true) return r.value;
    }
  }

  stream(request: ChatRequest, options: CallOptions = {}): ChatStream {
    // Preparation errors (validation, budget) surface on first iteration.
    const self = this;
    async function* run(): AsyncGenerator<StreamEvent, ChatResponse> {
      const prepared = self.#prepare(request, options);
      return yield* self.#streamGen(prepared);
    }
    return new ChatStream(run());
  }

  #prepare(request: ChatRequest, options: CallOptions): Prepared {
    const base = this.registry.get(request.model);
    const profile = this.#effectiveProfile(base);
    const adapter = this.#adapters[profile.provider];
    const now = this.#clock();
    const ctx: AdapterContext = { profile, request, maxOutputTokens: resolveMaxOutputTokens(request, profile), now };
    const built = adapter.buildRequest(ctx);
    const projection = projectCostUsd(request, profile, options.projectionOutputTokens ?? ctx.maxOutputTokens, now);
    const reservation = options.budget?.reserve(projection.projectedUsd, profile.id);
    const call: TransportCall = { provider: profile.provider, operation: built.operation, payload: built.payload };
    if (built.streamExtras !== undefined) call.streamExtras = built.streamExtras;
    if (built.endpoint !== undefined) call.endpoint = built.endpoint;
    if (request.signal !== undefined) call.signal = request.signal;
    return { ctx, built, adapter, call, transport: this.#transportFor(profile), budget: options.budget, reservation };
  }

  /** Anthropic: leave eager_input_streaming off behind a custom base URL (proxies may reject it - tool-use-concepts.md). */
  #effectiveProfile(profile: ModelProfile): ModelProfile {
    if (profile.provider === "anthropic" && this.#config.providers?.anthropic?.baseURL !== undefined && profile.capabilities.eagerInputStreaming) {
      return { ...profile, capabilities: { ...profile.capabilities, eagerInputStreaming: false } };
    }
    return profile;
  }

  async #send(p: Prepared): Promise<ChatResponse> {
    let response: ChatResponse;
    try {
      const raw = await p.transport.send(p.call);
      response = p.adapter.parseResponse(raw, p.ctx, p.built);
    } catch (err) {
      if (p.reservation !== undefined) p.budget?.release(p.reservation);
      throw normalizeProviderError(p.ctx.profile.provider, err);
    }
    this.#settle(p, response);
    return response;
  }

  async *#streamGen(p: Prepared): AsyncGenerator<StreamEvent, ChatResponse> {
    let lastUsage: Usage | undefined;
    let response: ChatResponse | undefined;
    try {
      const gen = p.adapter.parseStream(p.transport.stream(p.call), p.ctx, p.built);
      for (;;) {
        const r = await gen.next();
        if (r.done === true) {
          response = r.value;
          break;
        }
        if (r.value.type === "usage") lastUsage = r.value.usage;
        yield r.value;
      }
    } catch (err) {
      // Partial output of a failed stream can still be billed: charge what the provider already reported.
      if (p.reservation !== undefined && p.budget !== undefined) {
        if (lastUsage === undefined) p.budget.release(p.reservation);
        else p.budget.settle(p.reservation, { model: p.ctx.profile.id, responseId: "(failed stream)", costUsd: computeCostUsd(p.ctx.profile, lastUsage, p.ctx.now) });
      }
      throw normalizeProviderError(p.ctx.profile.provider, err);
    }
    this.#settle(p, response);
    return response;
  }

  #settle(p: Prepared, response: ChatResponse): void {
    const entry = { model: response.model, responseId: response.id, costUsd: response.costUsd };
    if (p.reservation !== undefined) p.budget?.settle(p.reservation, entry);
    this.ledger.push({
      ...entry,
      taskId: p.ctx.request.metadata?.taskId ?? "(none)",
      projectedUsd: p.reservation?.projectedUsd ?? 0,
      at: this.#clock().toISOString(),
    });
    if (this.#onWarning !== undefined) for (const w of response.warnings) this.#onWarning(w, response);
  }

  #transportFor(profile: ModelProfile): ProviderTransport {
    const injected = this.#injected[profile.provider];
    if (injected !== undefined) return injected;
    const providers = this.#config.providers ?? {};
    const envKey = (name: string | undefined): string | undefined =>
      name === undefined ? undefined : (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
    const clientOpts = (c: { apiKeyEnv?: string | undefined; baseURL?: string | undefined; maxRetries?: number | undefined; timeoutMs?: number | undefined } | undefined, apiKeyEnv?: string) => {
      const apiKey = envKey(apiKeyEnv ?? c?.apiKeyEnv);
      return {
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(c?.baseURL === undefined ? {} : { baseURL: c.baseURL }),
        ...(c?.maxRetries === undefined ? {} : { maxRetries: c.maxRetries }),
        ...(c?.timeoutMs === undefined ? {} : { timeoutMs: c.timeoutMs }),
      };
    };
    let key: string = profile.provider;
    let make: () => ProviderTransport;
    switch (profile.provider) {
      case "anthropic":
        make = () => new AnthropicSdkTransport(clientOpts(providers.anthropic));
        break;
      case "openai":
        make = () => new OpenAISdkTransport(clientOpts(providers.openai), "openai");
        break;
      case "google": {
        const g = providers.google;
        make = () =>
          new GoogleSdkTransport({
            ...clientOpts(g),
            ...(g?.vertexai === undefined ? {} : { vertexai: g.vertexai }),
            ...(g?.project === undefined ? {} : { project: g.project }),
            ...(g?.location === undefined ? {} : { location: g.location }),
          });
        break;
      }
      case "openai-compat": {
        const c = providers["openai-compat"];
        const baseURL = profile.compat?.baseURL ?? c?.baseURL;
        const apiKeyEnv = profile.compat?.apiKeyEnv ?? c?.apiKeyEnv;
        key = `openai-compat|${baseURL ?? ""}|${apiKeyEnv ?? ""}`;
        make = () => new OpenAISdkTransport({ ...clientOpts(c, apiKeyEnv), ...(baseURL === undefined ? {} : { baseURL }) }, "openai-compat");
        break;
      }
    }
    let t = this.#transports.get(key);
    if (t === undefined) {
      t = make();
      this.#transports.set(key, t);
    }
    return t;
  }
}

interface Prepared {
  ctx: AdapterContext;
  built: BuiltRequest;
  adapter: ProviderAdapter;
  call: TransportCall;
  transport: ProviderTransport;
  budget: BudgetGuard | undefined;
  reservation: Reservation | undefined;
}

import { randomBytes } from "node:crypto";
import { finalizeResponse, resolveEffort, type AdapterContext, type BuiltRequest, type ParsedResponse, type ProviderAdapter } from "../adapters/adapter.js";
import { GatewayError } from "../errors.js";
import {
  emptyUsage,
  type AssistantContentBlock,
  type ChatResponse,
  type CliProviderId,
  type EnvelopeVia,
  type PlanUsage,
  type StopReason,
  type StreamEvent,
  type Usage,
} from "../types.js";
import {
  envelopeAppendix,
  envelopeSchema,
  envelopeToContent,
  extractEnvelope,
  MAX_ENVELOPE_CALLS,
  neutralizeAtPaths,
  PLAIN_REPLY_APPENDIX,
  renderTranscript,
  restoreAtPaths,
  type TurnEnvelope,
} from "./envelope.js";
import { finalAssistantText, type CliEvent, type CliResultEvent } from "./events.js";
import { cliFailureToGatewayError } from "./failure.js";
import { addUsage } from "./parse.js";
import { CLI_COMPLETION_LIMITS, type CliExit, type CliFailure, type CliImage, type CliLimits, type CliProvider } from "./provider.js";

/** TransportCall.payload for operation "cli.turn": JSON-serializable, so Record/Replay transports work unchanged. */
export interface CliTurnPayload {
  protocol: 1;
  provider: CliProviderId;
  model: string | null;
  effort: string | null;
  /** System blocks + envelopeAppendix. */
  systemPrompt: string;
  /** renderTranscript(...).text */
  prompt: string;
  images: CliImage[];
  structured: { via: EnvelopeVia; schema: Record<string, unknown> } | null;
  toolNames: string[];
  limits: CliLimits;
}

/** What CliTransport.send resolves to (and what a replay fixture's `response` holds). */
export interface CliTurnOutcome {
  provider: CliProviderId;
  version: string;
  /** Normalized; parser tests use raw JSONL fixtures instead. */
  events: CliEvent[];
  exit: { code: number | null; signal: string | null; reason: CliExit["reason"] };
  envelope: unknown | null;
  envelopeSource: "structured" | "submit_turn" | "text" | null;
  failure: CliFailure | null;
  durationMs: number;
}

export interface CliAdapterOptions {
  /** Whether the paired transport has an MCP host (needed for the `mcp-submit` channel). Default false -> `text-json`. */
  mcpSubmit?: boolean;
  /** Random hex source (tests pin it). */
  randomHex?: (bytes: number) => string;
  /** Platform override for the Claude argv-length rule (tests). */
  platform?: string;
}

/** Claude passes the schema through argv; above this (or on Windows) the envelope goes through `mcp-submit`. */
export const CLAUDE_JSON_SCHEMA_ARGV_LIMIT = 24 * 1024;

function definedLimits(v: Partial<CliLimits> | undefined): Partial<CliLimits> {
  const out: Partial<CliLimits> = {};
  if (v === undefined) return out;
  if (typeof v.maxTurns === "number" && v.maxTurns > 0) out.maxTurns = Math.floor(v.maxTurns);
  if (typeof v.wallMs === "number" && v.wallMs > 0) out.wallMs = v.wallMs;
  if (typeof v.stallMs === "number" && v.stallMs > 0) out.stallMs = v.stallMs;
  if (typeof v.maxBudgetUsd === "number" && v.maxBudgetUsd > 0) out.maxBudgetUsd = v.maxBudgetUsd;
  return out;
}

/**
 * Pure mapping between the unified chat request and one stateless CLI invocation (docs/CLI-PROVIDERS.md §3.1, §7.8).
 * One `ChatRequest` -> one `CliTurnPayload`; one `CliTurnOutcome` -> one `ChatResponse` with `text` and `tool_use`
 * blocks that the orchestrator executes itself, exactly as for an API model.
 */
export class CliAdapter implements ProviderAdapter {
  readonly provider: CliProviderId;
  readonly #cli: CliProvider;
  readonly #mcpSubmit: boolean;
  readonly #hex: (bytes: number) => string;
  readonly #platform: string;

  constructor(provider: CliProvider, options: CliAdapterOptions = {}) {
    this.provider = provider.id;
    this.#cli = provider;
    this.#mcpSubmit = options.mcpSubmit ?? false;
    this.#hex = options.randomHex ?? ((n) => randomBytes(n).toString("hex"));
    this.#platform = options.platform ?? process.platform;
  }

  buildRequest(ctx: AdapterContext): BuiltRequest {
    const profile = ctx.profile;
    const cli = profile.cli;
    if (cli === undefined || profile.provider !== this.provider) {
      throw new GatewayError("config", `${profile.id} is not a ${this.provider} profile`, { provider: this.provider });
    }
    const warnings: string[] = [];
    const tools = ctx.request.toolChoice === "none" ? [] : [...(ctx.request.tools ?? [])];
    let via: EnvelopeVia | null = tools.length === 0 ? null : cli.envelopeVia;
    if (via === "mcp-submit" && !this.#mcpSubmit) {
      via = "text-json";
      warnings.push(`${profile.id}: no MCP host for the submit_turn channel; using the text-json envelope`);
    }
    let schema: Record<string, unknown> | null = null;
    if (via !== null) {
      const maxCalls = ctx.request.parallelToolCalls === false ? 1 : MAX_ENVELOPE_CALLS;
      const style = this.#cli.agent === "codex" && via === "json-schema" ? "openai-strict" : "plain";
      try {
        schema = envelopeSchema(tools, style, { maxCalls });
      } catch (e) {
        if (style !== "openai-strict") throw e;
        schema = envelopeSchema(tools, "plain", { maxCalls });
        via = "text-json";
        warnings.push(`${profile.id}: a tool schema is not valid in strict mode (${(e as Error).message}); using the text-json envelope`);
      }
      if (via === "json-schema" && this.#cli.agent === "claude" && (this.#platform === "win32" || JSON.stringify(schema).length > CLAUDE_JSON_SCHEMA_ARGV_LIMIT)) {
        via = this.#mcpSubmit ? "mcp-submit" : "text-json";
        warnings.push(`${profile.id}: the envelope schema is too long for argv; using the ${via} envelope`);
      }
    }
    const imageChannel = this.#cli.capabilities.images !== "none" && profile.capabilities.vision;
    const rendered = renderTranscript(ctx.request.messages, this.#hex(4), { images: imageChannel });
    warnings.push(...rendered.warnings);
    const prompt = this.#cli.agent === "gemini" ? neutralizeAtPaths(rendered.text) : rendered.text;
    const base = (ctx.request.system ?? []).map((s) => s.text).join("\n\n");
    const appendix = via === null ? PLAIN_REPLY_APPENDIX : envelopeAppendix(tools, via);
    const systemPrompt = base.length > 0 ? `${base}\n\n${appendix}` : appendix;
    const unified = resolveEffort(ctx, warnings);
    let effort: string | null = null;
    if (unified !== undefined) {
      effort = cli.effortArg?.[unified] ?? null;
      if (effort === null) warnings.push(`${profile.id}: reasoning effort '${unified}' has no CLI flag; using the CLI default`);
    }
    const payload: CliTurnPayload = {
      protocol: 1,
      provider: this.provider,
      model: cli.modelArg,
      effort,
      systemPrompt,
      prompt,
      images: rendered.images,
      structured: via === null || schema === null ? null : { via, schema },
      toolNames: tools.map((t) => t.name),
      limits: { ...CLI_COMPLETION_LIMITS, ...definedLimits(ctx.request.providerOptions?.cli?.limits) },
    };
    return { operation: "cli.turn", payload: payload as unknown as Record<string, unknown>, preferStream: false, warnings };
  }

  parseResponse(raw: unknown, ctx: AdapterContext, built: BuiltRequest): ChatResponse {
    const outcome = asOutcome(raw, this.provider);
    if (outcome.failure !== null) throw cliFailureToGatewayError(this.provider, outcome.failure);
    const payload = built.payload as unknown as CliTurnPayload;
    const profile = ctx.profile;
    const tools = (ctx.request.tools ?? []).filter((t) => payload.toolNames.includes(t.name));
    const results = outcome.events.filter((e): e is CliResultEvent => e.type === "result");
    const last = results.at(-1) ?? null;
    const init = outcome.events.find((e) => e.type === "init");
    const warnings: string[] = [];
    for (const e of outcome.events) if (e.type === "warning" && warnings.length < 10 && !warnings.includes(e.message)) warnings.push(e.message);

    let content: AssistantContentBlock[];
    let stop: StopReason;
    if (payload.structured === null) {
      // Same rule as the transport (a Gemini/opencode result may carry "" while the text came as events).
      const raw = finalAssistantText(outcome.events) ?? "";
      const text = this.#cli.agent === "gemini" ? restoreAtPaths(raw) : raw;
      content = text.length > 0 ? [{ type: "text", text }] : [];
      // The last model turn decides: a reply cut off at the output limit must not look complete.
      const lastTurn = [...outcome.events].reverse().find((e): e is Extract<CliEvent, { type: "turn" }> => e.type === "turn");
      stop = lastTurn?.stopReason === "max_tokens" || lastTurn?.stopReason === "refusal" ? lastTurn.stopReason : "end_turn";
    } else {
      const ex = extractEnvelope(outcome.envelope, outcome.envelopeSource ?? "structured");
      if (!ex.ok) throw new GatewayError("bad_output", `${this.provider}: invalid turn envelope: ${ex.error}`, { provider: this.provider });
      // Gemini: undo neutralizeAtPaths (tool arguments must carry the real `@aicad/std`).
      const envelope: TurnEnvelope = this.#cli.agent === "gemini" ? restoreAtPaths(ex.envelope) : ex.envelope;
      const turn = ctx.request.messages.filter((m) => m.role === "assistant").length;
      content = envelopeToContent(envelope, tools, this.#hex(4), turn);
      stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
    }
    const refusal = outcome.events.find((e) => e.type === "refusal");
    if (refusal !== undefined) stop = "refusal";

    let usage: Usage | null = null;
    let cost: number | null = null;
    for (const r of results) {
      usage = addUsage(usage, r.usage);
      if (r.costUsd !== null) cost = (cost ?? 0) + r.costUsd;
    }
    if (usage === null) for (const e of outcome.events) if (e.type === "turn") usage = addUsage(usage, e.usage);
    // Providers list the main model first (Claude orders modelUsage by output tokens); CLIs also make small side calls
    // on other models, so the reported model is the first one in the profile's family, and the family warning fires
    // only when NO model used is in the family (auto routing, quota fallback).
    const modelsUsed = [...new Set(results.flatMap((r) => r.models))];
    const sessionId = last?.sessionId ?? (init?.type === "init" ? init.sessionId : null);
    const familyKey = profile.family.replace(/^(claude|gemini|cursor)-/, "").toLowerCase();
    const inFamily = familyKey === "auto" ? modelsUsed : modelsUsed.filter((m) => m.toLowerCase().includes(familyKey));
    if (modelsUsed.length > 0 && inFamily.length === 0) {
      warnings.push(`${profile.id}: the CLI ran ${modelsUsed.map((m) => `'${m}'`).join(", ")}, outside the profile's family '${profile.family}'`);
    }
    const parsed: ParsedResponse = {
      id: `cli_${sessionId ?? this.#hex(8)}`,
      providerModel: inFamily[0] ?? modelsUsed[0] ?? (init?.type === "init" ? init.model : null) ?? profile.cli?.modelArg ?? profile.apiModelId,
      content,
      stopReason: stop,
      providerStopReason: last?.subtype ?? null,
      usage: usage ?? emptyUsage(),
      warnings,
      providerRaw: outcome,
    };
    if (refusal?.type === "refusal") parsed.refusal = { category: null, explanation: refusal.message };
    // A subscription's notional cost is the CLI-reported list-price figure (Claude); otherwise the profile's pricing.
    if (cost !== null) parsed.providerCostUsd = cost;
    const response = finalizeResponse(ctx, built, parsed);
    const plan = [...outcome.events].reverse().find((e): e is Extract<CliEvent, { type: "plan_usage" }> => e.type === "plan_usage");
    if (plan !== undefined) response.planUsage = plan.usage satisfies PlanUsage;
    const reportedTurns = results.reduce((n, r) => n + (r.turns ?? 0), 0);
    const turnEvents = outcome.events.filter((e) => e.type === "turn").length;
    response.cli = {
      provider: this.provider,
      version: outcome.version,
      sessionId,
      turns: reportedTurns > 0 ? reportedTurns : turnEvents > 0 ? turnEvents : null,
      modelsUsed,
      envelopeVia: payload.structured?.via ?? null,
      durationMs: outcome.durationMs,
    };
    return response;
  }

  async *parseStream(events: AsyncIterable<unknown>, ctx: AdapterContext, built: BuiltRequest): AsyncGenerator<StreamEvent, ChatResponse> {
    let outcome: unknown = undefined;
    for await (const e of events) outcome = e;
    const response = this.parseResponse(outcome, ctx, built);
    yield { type: "message_start", provider: this.provider, model: response.model, providerModel: response.providerModel };
    for (const [index, b] of response.message.content.entries()) {
      if (b.type === "text") yield { type: "text_delta", index, text: b.text };
      else if (b.type === "tool_use") {
        yield { type: "tool_use_start", index, id: b.id, name: b.name };
        const end: StreamEvent = { type: "tool_use_end", index, id: b.id, name: b.name, input: b.input };
        if (b.inputError !== undefined) end.inputError = b.inputError;
        yield end;
      }
    }
    yield { type: "usage", usage: response.usage };
    yield { type: "message_end", response };
    return response;
  }
}

function asOutcome(raw: unknown, provider: CliProviderId): CliTurnOutcome {
  const o = raw as Partial<CliTurnOutcome> | null | undefined;
  if (o === null || o === undefined || typeof o !== "object" || !Array.isArray(o.events) || o.provider !== provider) {
    throw new GatewayError("bad_output", `${provider}: the transport returned no CLI outcome`, { provider });
  }
  return o as CliTurnOutcome;
}

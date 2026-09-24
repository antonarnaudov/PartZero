import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "../adapters/adapter.js";
import { GatewayError } from "../errors.js";
import type { ProviderTransport, TransportCall } from "../transport/transport.js";
import type { CliProviderId, PlanUsage } from "../types.js";
import { CliAdapter, type CliTurnOutcome, type CliTurnPayload } from "./adapter.js";
import { binaryRefusal, cliEnvForBinary } from "./base.js";
import { envelopeRepairNote, extractEnvelope, submitTurnToolDef, type TurnEnvelope } from "./envelope.js";
import { finalAssistantText, type CliEvent } from "./events.js";
import { SUBMIT_BROKER_LIMITS, SUBMIT_TURN_OK_TEXT, type CliMcpHost, type CliMcpSession } from "./mcp.js";
import type { CliBinary, CliFailure, CliInvocation, CliProvider, CliRunIO } from "./provider.js";
import { CLI_PROVIDERS } from "./registry.js";
import { createCliWorkspace } from "./workspace.js";

export interface CliTransportOptions {
  provider: CliProvider;
  /** Host detection cache; the transport re-stats the binary before every spawn. */
  binary(): Promise<CliBinary>;
  /** Host base env for cliChildEnv. */
  env(): Readonly<Record<string, string>>;
  workspaceRoot?: string;
  /** Required for envelopeVia "mcp-submit". */
  mcpHost?: CliMcpHost;
  onPlanUsage?(usage: PlanUsage): void;
  /** Debugging only: keep workspaces (kept files never contain the ticket). */
  keepWorkspaces?: boolean;
  /** Raw stdout JSONL lines of every invocation (fixture recording). Untrusted data. */
  onStdoutLine?(line: string): void;
}

/** Failures that a valid envelope does not override. */
const HARD_FAILURES = new Set<CliFailure["code"]>(["lockdown_violation", "cancelled", "not_logged_in", "quota_exhausted", "rate_limited", "not_installed", "unsupported", "budget"]);
const SUBMIT_CLOSE_GRACE_MS = 5_000;

function isPayload(v: unknown, provider: CliProviderId): v is CliTurnPayload {
  const p = v as Partial<CliTurnPayload> | null;
  return typeof p === "object" && p !== null && p.protocol === 1 && p.provider === provider && typeof p.prompt === "string" && typeof p.systemPrompt === "string";
}

/**
 * One `cli.turn` call -> one fresh, stateless, locked-down CLI invocation (§3.1): fresh workspace, allowlisted env,
 * no session persisted or resumed. Resolves with a {@link CliTurnOutcome}; the envelope is extracted and validated
 * here (with the single `text-json` repair invocation), the adapter maps it.
 */
export class CliTransport implements ProviderTransport {
  readonly #o: CliTransportOptions;

  constructor(options: CliTransportOptions) {
    this.#o = options;
  }

  async send(call: TransportCall): Promise<CliTurnOutcome> {
    const provider = this.#o.provider;
    if (call.operation !== "cli.turn" || !isPayload(call.payload, provider.id)) {
      throw new GatewayError("invalid_request", `${provider.id}: CliTransport only serves cli.turn calls for ${provider.id}`, { provider: provider.id });
    }
    const payload = call.payload;
    const started = Date.now();
    const binary = await this.#o.binary();
    const refused = this.#refusal(binary);
    if (refused !== null) return this.#failed(binary, refused, started);

    const first = await this.#invoke(payload, binary, payload.prompt, call.signal);
    if (payload.structured?.via !== "text-json" || first.failure !== null || first.envelope !== null || first.envelopeError === null) {
      return this.#finish(first, binary, started);
    }
    // text-json: exactly one repair invocation with the same stateless payload + the invalid reply + the fixed note.
    const invalid = (first.finalText ?? "").slice(0, 16_384);
    const prompt = `${payload.prompt}\n\nYour previous reply was:\n<previous-reply>\n${invalid}\n</previous-reply>\n${envelopeRepairNote(first.envelopeError)}`;
    const second = await this.#invoke(payload, binary, prompt, call.signal);
    second.events = [...first.events, { type: "warning", message: `repaired an invalid envelope (${first.envelopeError})` }, ...second.events];
    return this.#finish(second, binary, started);
  }

  async *stream(call: TransportCall): AsyncIterable<CliTurnOutcome> {
    yield await this.send(call);
  }

  #refusal(binary: CliBinary): CliFailure | null {
    return binaryRefusal(this.#o.provider, binary);
  }

  #failed(binary: CliBinary, failure: CliFailure, started: number): CliTurnOutcome {
    return {
      provider: this.#o.provider.id,
      version: binary.version,
      events: [],
      exit: { code: null, signal: null, reason: "spawn_failed" },
      envelope: null,
      envelopeSource: null,
      failure,
      durationMs: Date.now() - started,
    };
  }

  #finish(r: InvokeResult, binary: CliBinary, started: number): CliTurnOutcome {
    let failure = r.failure;
    const needsEnvelope = r.structured;
    if (needsEnvelope && r.envelope !== null && failure !== null && !HARD_FAILURES.has(failure.code)) {
      r.events.push({ type: "warning", message: `the CLI ended with '${failure.code}' after delivering a valid envelope (${failure.message})` });
      failure = null;
    }
    if (failure === null && needsEnvelope && r.envelope === null) failure = { code: "bad_output", message: `no valid turn envelope: ${r.envelopeError ?? "nothing was returned"}` };
    return {
      provider: this.#o.provider.id,
      version: binary.version,
      events: r.events,
      exit: r.exit,
      envelope: r.envelope,
      envelopeSource: r.envelopeSource,
      failure,
      durationMs: Date.now() - started,
    };
  }

  async #invoke(payload: CliTurnPayload, binary: CliBinary, prompt: string, signal: AbortSignal | undefined): Promise<InvokeResult> {
    const provider = this.#o.provider;
    const via = payload.structured?.via ?? null;
    const workspace = await createCliWorkspace({
      runId: randomUUID(),
      ...(this.#o.workspaceRoot === undefined ? {} : { root: this.#o.workspaceRoot }),
      ...(this.#o.keepWorkspaces === true ? { keep: true } : {}),
      ...(provider.agent === "gemini" ? { basename: "aicad-run" } : {}),
    });
    let session: CliMcpSession | null = null;
    let submitted: TurnEnvelope | null = null;
    let inv: CliInvocation | null = null;
    let sessionId: string | null = null;
    try {
      if (via === "mcp-submit") {
        const host = this.#o.mcpHost;
        if (host === undefined || payload.structured === null) {
          return this.#early({ code: "unsupported", message: "the mcp-submit envelope channel needs an MCP host" }, payload);
        }
        session = await host
          .open({
          dir: workspace.socketDir,
          scope: "submit",
          tools: [submitTurnToolDef(payload.structured.schema)],
          instructions: "Submit your turn envelope with submit_turn, once.",
          limits: SUBMIT_BROKER_LIMITS,
          handler: async (call) => {
            if (call.name !== "submit_turn") return { text: `Unknown tool ${call.name}. Only submit_turn is available.`, isError: true };
            const ex = extractEnvelope(call.args, "submit_turn");
            if (!ex.ok) return { text: `Invalid turn envelope: ${ex.error}. Fix it and call submit_turn again.`, isError: true };
            submitted = ex.envelope;
            return { text: SUBMIT_TURN_OK_TEXT, isError: false, close: "submitted" };
          },
        })
          .catch(() => null);
        if (session === null) return this.#early({ code: "crashed", message: "the CAD MCP broker could not be started" }, payload);
      }
      const extra: Record<string, string> = session === null ? {} : { AICAD_MCP_TICKET: session.ticket };
      const env = cliEnvForBinary(binary, this.#o.env(), workspace.tmp, extra);
      inv = {
        runId: randomUUID(),
        mode: "completion",
        binary,
        workspace,
        model: payload.model,
        effort: payload.effort,
        systemPrompt: payload.systemPrompt,
        prompt,
        images: payload.images,
        structured: payload.structured,
        mcp: session?.attachment ?? null,
        resume: null,
        limits: payload.limits,
        env,
      };
      const io: CliRunIO = {};
      if (signal !== undefined) io.signal = signal;
      if (this.#o.onStdoutLine !== undefined) io.onStdoutLine = this.#o.onStdoutLine;
      const run = provider.run(inv, io);
      const events: CliEvent[] = [];
      let grace: ReturnType<typeof setTimeout> | null = null;
      for await (const e of run.events) {
        events.push(e);
        if (e.type === "plan_usage") this.#o.onPlanUsage?.(e.usage);
        if (e.type === "init" && e.sessionId !== null) sessionId = e.sessionId;
        if (e.type === "result" && e.sessionId !== null) sessionId = e.sessionId;
        if (submitted !== null && grace === null) {
          // The broker closed after a valid submit: give the CLI the grace period to end its turn, then stop it.
          grace = setTimeout(() => void provider.cancel(run, "stop"), SUBMIT_CLOSE_GRACE_MS);
        }
      }
      const exit = await run.done;
      if (grace !== null) clearTimeout(grace);

      let envelope: TurnEnvelope | null = null;
      let source: CliTurnOutcome["envelopeSource"] = null;
      let envelopeError: string | null = null;
      const finalText = finalAssistantText(events);
      if (payload.structured !== null) {
        const captured = submitted as TurnEnvelope | null;
        if (captured !== null) {
          envelope = captured;
          source = "submit_turn";
        } else {
          const structured = [...events].reverse().find((e) => e.type === "structured");
          const candidate: { raw: unknown; src: "structured" | "text" } | null =
            via === "json-schema" && structured?.type === "structured" ? { raw: structured.value, src: "structured" } : finalText !== null ? { raw: finalText, src: "text" } : null;
          if (candidate !== null) {
            const ex = extractEnvelope(candidate.raw, candidate.src);
            if (ex.ok) {
              envelope = ex.envelope;
              source = candidate.src;
            } else envelopeError = ex.error;
          } else envelopeError = "the CLI returned no reply";
        }
      }
      return {
        events,
        exit: { code: exit.code, signal: exit.signal, reason: exit.reason },
        envelope,
        envelopeSource: source,
        envelopeError,
        finalText,
        failure: exit.failure,
        structured: payload.structured !== null,
      };
    } finally {
      if (inv !== null && provider.cleanup !== undefined) await provider.cleanup(inv, sessionId).catch(() => undefined);
      await session?.dispose().catch(() => undefined);
      await workspace.dispose().catch(() => undefined);
    }
  }

  #early(failure: CliFailure, payload: CliTurnPayload): InvokeResult {
    return { events: [], exit: { code: null, signal: null, reason: "spawn_failed" }, envelope: null, envelopeSource: null, envelopeError: null, finalText: null, failure, structured: payload.structured !== null };
  }
}

interface InvokeResult {
  events: CliEvent[];
  exit: CliTurnOutcome["exit"];
  envelope: TurnEnvelope | null;
  envelopeSource: CliTurnOutcome["envelopeSource"];
  envelopeError: string | null;
  finalText: string | null;
  failure: CliFailure | null;
  structured: boolean;
}


/** Node-only helper for hosts: adapters + transports for the CLI providers. */
export function cliGatewayParts(options: {
  providers?: readonly CliProviderId[];
  binary(provider: CliProviderId): Promise<CliBinary>;
  env(): Readonly<Record<string, string>>;
  mcpHost?: CliMcpHost;
  workspaceRoot?: string;
  onPlanUsage?(usage: PlanUsage): void;
}): { adapters: Partial<Record<CliProviderId, ProviderAdapter>>; transports: Partial<Record<CliProviderId, ProviderTransport>> } {
  const adapters: Partial<Record<CliProviderId, ProviderAdapter>> = {};
  const transports: Partial<Record<CliProviderId, ProviderTransport>> = {};
  for (const id of options.providers ?? [...CLI_PROVIDERS.keys()]) {
    const provider = CLI_PROVIDERS.get(id);
    if (provider === undefined) continue;
    adapters[id] = new CliAdapter(provider, { mcpSubmit: options.mcpHost !== undefined });
    transports[id] = new CliTransport({
      provider,
      binary: () => options.binary(id),
      env: options.env,
      ...(options.mcpHost === undefined ? {} : { mcpHost: options.mcpHost }),
      ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
      ...(options.onPlanUsage === undefined ? {} : { onPlanUsage: options.onPlanUsage }),
    });
  }
  return { adapters, transports };
}

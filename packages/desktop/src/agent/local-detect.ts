/**
 * Local models (Ollama) as the main process sees them (docs/CLI-PROVIDERS.md §10, §11.5).
 *
 * The server is probed over HTTP (`/api/version`, `/api/tags`, `/api/show`); results are cached for 30 s, and
 * Settings → Re-check forces a new probe. The app never pulls models: a missing model shows the `ollama pull <tag>`
 * command, because disk space is the user's call. Local profiles reach the server through its OpenAI-compatible
 * `/v1` endpoint, so the worker checks the loaded context (`ollamaContextCheck`) before and during a local run.
 */
import type { LocalProviderStatus } from "@aicad/app/bridge";
import { BUILTIN_LOCAL_PROFILES, DEFAULT_OLLAMA_URL, ollamaProfile, type ModelProfile } from "@aicad/llm-gateway";
import type { OllamaStatus } from "@aicad/llm-gateway/cli";

export const LOCAL_TTL_MS = 30_000;

export type OllamaProbe = (baseURL: string, options: { allowRemote?: boolean; timeoutMs?: number }) => Promise<OllamaStatus>;

export interface LocalModelsDeps {
  /** The configured base URL (null = the default loopback URL). */
  baseUrl: () => string | null;
  probe: OllamaProbe;
  now?: () => number;
}

/** A built-in local profile pointed at another Ollama base URL. */
export function rebaseLocalProfile(p: ModelProfile, baseUrl: string): ModelProfile {
  const root = baseUrl.replace(/\/+$/, "");
  if (p.local === undefined || p.local.baseURL === root) return p;
  return { ...p, local: { ...p.local, baseURL: root }, ...(p.compat ? { compat: { ...p.compat, baseURL: `${root}/v1` } } : {}) };
}

export class LocalModels {
  readonly #deps: LocalModelsDeps;
  #status: OllamaStatus | null = null;
  /** The base URL `#status` belongs to. */
  #url: string | null = null;
  #at = 0;
  /** Probes in flight, per base URL: a probe of one URL is never taken as the answer for another. */
  readonly #inflight = new Map<string, Promise<void>>();

  constructor(deps: LocalModelsDeps) {
    this.#deps = deps;
  }

  get baseUrl(): string {
    return (this.#deps.baseUrl() ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  }

  /** `<base>/v1`: OpenAI-compatible calls to it are local (no compat key, no compat URL override). */
  get endpoint(): string {
    return `${this.baseUrl}/v1`;
  }

  async status(options: { force?: boolean } = {}): Promise<LocalProviderStatus> {
    const url = this.baseUrl;
    const fresh = this.#status !== null && this.#url === url && (this.#deps.now?.() ?? Date.now()) - this.#at <= LOCAL_TTL_MS;
    if (options.force === true || !fresh) {
      await this.#probe(url);
      // The URL changed while that probe ran: answer for the URL configured now, not the old one.
      const current = this.baseUrl;
      if (current !== url && this.#url !== current) await this.#probe(current);
    }
    return this.view();
  }

  #probe(url: string): Promise<void> {
    const running = this.#inflight.get(url);
    if (running) return running;
    const p = (async () => {
      let status: OllamaStatus;
      try {
        // A URL other than the default was set explicitly in Settings (already https, or http on loopback).
        status = await this.#deps.probe(url, { allowRemote: this.#deps.baseUrl() !== null, timeoutMs: 3_000 });
      } catch (e) {
        status = { running: false, version: null, models: [], detail: `probe failed: ${(e as Error).message}` };
      }
      // The URL changed in Settings while this probe ran: its answer belongs to the old URL and is dropped.
      if (this.baseUrl !== url) return;
      this.#status = status;
      this.#url = url;
      this.#at = this.#deps.now?.() ?? Date.now();
    })().finally(() => {
      if (this.#inflight.get(url) === p) this.#inflight.delete(url);
    });
    this.#inflight.set(url, p);
    return p;
  }

  /** The last probe's answer when it belongs to the configured URL, else null (not checked yet). */
  #current(): OllamaStatus | null {
    return this.#url === this.baseUrl ? this.#status : null;
  }

  view(): LocalProviderStatus {
    const s = this.#current();
    return {
      id: "ollama",
      baseUrl: this.baseUrl,
      running: s?.running ?? false,
      version: s?.version ?? null,
      models: (s?.models ?? []).map((m) => ({ id: `ollama:${m.tag}`, tag: m.tag, tools: m.tools, vision: m.vision, contextLength: m.contextLength })),
      detail: s?.detail ?? "not checked yet",
    };
  }

  /**
   * Local profiles to offer: every tool-capable model the server has, plus the built-in suggestions that are not
   * pulled yet (listed as unavailable with the pull command).
   */
  profiles(): ModelProfile[] {
    const url = this.baseUrl;
    const found = (this.#current()?.models ?? []).filter((m) => m.tools).map((m) => ollamaProfile(m, url));
    const ids = new Set(found.map((p) => p.id));
    return [...found, ...BUILTIN_LOCAL_PROFILES.filter((p) => !ids.has(p.id)).map((p) => rebaseLocalProfile(p, url))];
  }
}

import { DEFAULT_OLLAMA_URL, ollamaProfile, type OllamaModelInfo } from "../builtin-profiles.js";
import type { ModelProfile } from "../profile.js";
import { runCommand } from "./process.js";

/**
 * Local model discovery for Ollama (docs/CLI-PROVIDERS.md §10). The server is probed over loopback HTTP
 * (`/api/version`, `/api/tags`, `/api/show`); `ollama list` is a fallback for the tag list. The app never pulls models:
 * Settings shows the `ollama pull <tag>` command, because disk space is the user's call. Discovered models become
 * `ollama:<tag>` profiles that reach the server through its OpenAI-compatible `/v1` endpoint.
 */

export type { OllamaModelInfo } from "../builtin-profiles.js";
export { DEFAULT_OLLAMA_URL, ollamaProfile } from "../builtin-profiles.js";

export interface OllamaStatus {
  running: boolean;
  version: string | null;
  models: OllamaModelInfo[];
  detail: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Refuses credentials in the URL and non-http(s) schemes. A non-loopback URL is allowed only when the caller says it
 * was set explicitly in Settings.
 */
export function ollamaBaseUrlProblem(baseURL: string, options: { allowRemote?: boolean } = {}): string | null {
  let u: URL;
  try {
    u = new URL(baseURL);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "must be http or https";
  if (u.username !== "" || u.password !== "") return "credentials in the URL are not allowed";
  if (!LOOPBACK.has(u.hostname) && options.allowRemote !== true) return "only a loopback address is allowed unless set explicitly in Settings";
  return null;
}

type FetchLike = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Parse an `/api/show` response into capability info. */
export function ollamaModelInfo(tag: string, show: unknown): OllamaModelInfo {
  const s = rec(show);
  const caps = Array.isArray(s["capabilities"]) ? (s["capabilities"] as unknown[]).filter((c): c is string => typeof c === "string") : [];
  const details = rec(s["details"]);
  const info = rec(s["model_info"]);
  let contextLength: number | null = null;
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith(".context_length") && typeof v === "number" && Number.isFinite(v) && v > 0) contextLength = v;
  }
  return {
    tag,
    family: typeof details["family"] === "string" ? details["family"] : null,
    parameterSize: typeof details["parameter_size"] === "string" ? details["parameter_size"] : null,
    tools: caps.includes("tools"),
    vision: caps.includes("vision"),
    thinking: caps.includes("thinking"),
    contextLength,
  };
}

/** `/api/version`, `/api/tags`, `/api/show` per model (at most 50). Never throws; `running: false` on any failure. */
export async function probeOllama(
  baseURL: string = DEFAULT_OLLAMA_URL,
  options: { timeoutMs?: number; signal?: AbortSignal; allowRemote?: boolean; fetch?: FetchLike } = {},
): Promise<OllamaStatus> {
  const problem = ollamaBaseUrlProblem(baseURL, options.allowRemote === undefined ? {} : { allowRemote: options.allowRemote });
  if (problem !== null) return { running: false, version: null, models: [], detail: `Ollama URL refused: ${problem}` };
  const f: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const root = baseURL.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 3_000;
  const call = async (path: string, body?: unknown): Promise<unknown> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = (): void => ctl.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const init: Parameters<FetchLike>[1] = { signal: ctl.signal };
      if (body !== undefined) {
        init.method = "POST";
        init.body = JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }
      const r = await f(`${root}${path}`, init);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  };
  let version: string | null;
  try {
    const v = rec(await call("/api/version"));
    version = typeof v["version"] === "string" ? v["version"] : null;
  } catch (e) {
    return { running: false, version: null, models: [], detail: `Ollama is not reachable at ${root} (${(e as Error).message})` };
  }
  let tags: string[] = [];
  try {
    const t = rec(await call("/api/tags"));
    tags = (Array.isArray(t["models"]) ? t["models"] : [])
      .map((m) => rec(m)["name"] ?? rec(m)["model"])
      .filter((n): n is string => typeof n === "string" && /^[\w.:/-]{1,128}$/.test(n))
      .slice(0, 50);
  } catch (e) {
    return { running: true, version, models: [], detail: `could not list models (${(e as Error).message})` };
  }
  const models: OllamaModelInfo[] = [];
  for (const tag of tags) {
    try {
      models.push(ollamaModelInfo(tag, await call("/api/show", { model: tag })));
    } catch {
      models.push({ tag, family: null, parameterSize: null, tools: false, vision: false, thinking: false, contextLength: null });
    }
  }
  const usable = models.filter((m) => m.tools).length;
  return {
    running: true,
    version,
    models,
    detail: models.length === 0 ? "Ollama is running but has no models; pull one with `ollama pull <tag>`" : `${models.length} model(s), ${usable} with tool calling`,
  };
}

/** Result of {@link ollamaContextCheck}. */
export interface OllamaContextCheck {
  /** false: the loaded model has less context than the profile needs; null: unknown (not loaded, or not reported). */
  ok: boolean | null;
  /** Context the server loaded the model with (`/api/ps` `context_length`), when reported. */
  loadedContext: number | null;
  /** The profile's `local.numCtx`. */
  required: number;
  /** User-facing warning when `ok === false`, else null. */
  warning: string | null;
}

/**
 * Pre-run (and after-first-call) check for local profiles (§10, amended): the `/v1` endpoint cannot set `num_ctx` per
 * request, so a server started without `OLLAMA_CONTEXT_LENGTH >= local.numCtx` silently truncates the prompt. `/api/ps`
 * reports the context each LOADED model runs with; this compares it with the profile. A model that is not loaded yet
 * gives `ok: null` (hosts re-check after the first call). Never throws; loopback only unless `allowRemote`.
 */
export async function ollamaContextCheck(
  profile: Pick<ModelProfile, "id" | "local">,
  options: { timeoutMs?: number; signal?: AbortSignal; allowRemote?: boolean; fetch?: FetchLike } = {},
): Promise<OllamaContextCheck> {
  const local = profile.local;
  if (local === undefined) return { ok: null, loadedContext: null, required: 0, warning: null };
  const unknown: OllamaContextCheck = { ok: null, loadedContext: null, required: local.numCtx, warning: null };
  if (ollamaBaseUrlProblem(local.baseURL, options.allowRemote === undefined ? {} : { allowRemote: options.allowRemote }) !== null) return unknown;
  const f: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), options.timeoutMs ?? 3_000);
  const onAbort = (): void => ctl.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await f(`${local.baseURL.replace(/\/+$/, "")}/api/ps`, { signal: ctl.signal });
    if (!r.ok) return unknown;
    const models = rec(await r.json())["models"];
    for (const m of Array.isArray(models) ? models : []) {
      const e = rec(m);
      if (e["name"] !== local.tag && e["model"] !== local.tag) continue;
      const ctx = e["context_length"];
      if (typeof ctx !== "number" || !Number.isFinite(ctx) || ctx <= 0) return unknown;
      const ok = ctx >= local.numCtx;
      return {
        ok,
        loadedContext: ctx,
        required: local.numCtx,
        warning: ok
          ? null
          : `${profile.id}: Ollama runs ${local.tag} with a ${ctx}-token context, below the ${local.numCtx} this profile needs; long prompts are silently truncated. Restart Ollama with OLLAMA_CONTEXT_LENGTH=${local.numCtx} (or more).`,
      };
    }
    return unknown;
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Tags from `ollama list` output (`NAME  ID  SIZE  MODIFIED` table). */
export function parseOllamaList(text: string): string[] {
  const tags: string[] = [];
  for (const line of text.split("\n")) {
    const first = line.trim().split(/\s+/)[0] ?? "";
    if (first === "" || first === "NAME") continue;
    if (/^[\w.:/-]{1,128}$/.test(first) && !tags.includes(first)) tags.push(first);
  }
  return tags;
}

/** `ollama list` through the binary (fallback when the HTTP probe is not wanted). Needs the server too. */
export async function ollamaListTags(binaryPath: string, env: Readonly<Record<string, string>>, cwd: string): Promise<string[]> {
  const r = await runCommand(binaryPath, ["list"], { cwd, env, timeoutMs: 10_000, maxBytes: 256 * 1024 });
  return r.code === 0 ? parseOllamaList(r.stdout) : [];
}

/** Profiles for the tool-capable models a probe found (agent roles need tools; the judge needs vision). */
export function ollamaProfilesFrom(status: OllamaStatus, baseURL: string = DEFAULT_OLLAMA_URL): ModelProfile[] {
  return status.models.filter((m) => m.tools).map((m) => ollamaProfile(m, baseURL));
}

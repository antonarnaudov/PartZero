/**
 * Agent settings that are not secret, and the provider picture the renderer sees.
 *
 * Stored in `<userData>/agent-settings.json` (keys are in `keys.ts`, never here): the model per role, the per-task
 * budget, the OpenAI-compatible base URL, CLI path overrides, the CLI mode, the Ollama base URL and the CLI binaries
 * blocked after a lockdown violation (they stay blocked across restarts until Re-check passes: `cli-detect.ts`).
 *
 * Every model is a gateway profile of one of three provider kinds (ADR 0014): `api` (a key), `cli` (the user's own
 * CLI login and plan) and `local` (Ollama). Keys are optional. When the user has not chosen models, the defaults come
 * from the first ready provider in the order of docs/CLI-PROVIDERS.md §9.3: Claude Code, Codex, Gemini CLI, opencode,
 * then the API keys, then Ollama. When only the designer is chosen, the spec writer follows it and triage uses that
 * provider's small model (`smallModelForProfile`), so a run needs exactly one provider.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  AgentRoleId,
  AgentSettingsView,
  AgentTransportKind,
  ApiProviderId,
  BillingKind,
  AutonomySetting,
  CliModeSetting,
  CliProviderId,
  CliProviderStatus,
  LocalProviderStatus,
  ModelProfileInfo,
  ProviderId,
  ProviderKindId,
  SettingsUpdate,
} from "@aicad/app/bridge";
import {
  BUILTIN_CLI_PROFILES,
  BUILTIN_LOCAL_PROFILES,
  BUILTIN_PROFILES,
  DEFAULT_ROUTING,
  ProfileRegistry,
  profileKind,
  Router,
  smallModelForProfile,
  type ModelProfile,
  type RoutingConfig,
} from "@aicad/llm-gateway";
import { CLI_PROVIDERS } from "@aicad/llm-gateway/cli";
import { cliPathShapeProblem, MAX_CLI_BLOCKS, type CliBlock } from "./cli-detect.js";
import { PROVIDERS, type KeyResolver } from "./keys.js";
import { AUTONOMY_SETTINGS, baseUrlProblem, CLI_MODES, CLI_PROVIDER_IDS, isApiProviderId, isCliProviderId, MAX_BUDGET_USD, MIN_BUDGET_USD, PROTOCOL_VERSION, ROLE_IDS } from "./protocol.js";

export const DEFAULT_BUDGET_USD = 1.0;

export interface StoredSettings {
  v: 1;
  models: Partial<Record<AgentRoleId, string>>;
  budgetUsd: number;
  compatBaseUrl: string | null;
  /** Settings → CLI path overrides (validated when set; re-validated by detection). */
  cliPaths: Partial<Record<CliProviderId, string>>;
  cliMode: CliModeSetting;
  /** null = http://127.0.0.1:11434. */
  ollamaBaseUrl: string | null;
  /** The autonomy dial (ADR 0015): set by the user only (Assistant header, Settings); default `review`. */
  autonomy: AutonomySetting;
  /** CLI binaries blocked after a lockdown violation (§5.5, §5.6): kept until a forced Re-check passes or the file changes. */
  cliBlocks: CliBlock[];
}

const DEFAULTS: StoredSettings = { v: 1, models: {}, budgetUsd: DEFAULT_BUDGET_USD, compatBaseUrl: null, cliPaths: {}, cliMode: "auto", ollamaBaseUrl: null, autonomy: "review", cliBlocks: [] };
const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  "openai-compat": "OpenAI-compatible",
  "claude-cli": "Claude Code",
  "gemini-cli": "Gemini CLI",
  "codex-cli": "Codex CLI",
  opencode: "opencode",
  "cursor-agent": "Cursor Agent",
  ollama: "Ollama",
};

export function providerLabel(p: ProviderId): string {
  return PROVIDER_LABELS[p];
}

/**
 * The profile registry the app offers: the built-in API and CLI profiles plus `extra` (local and discovered CLI
 * profiles; a later profile with the same id replaces an earlier one).
 */
export function profileRegistry(extra: readonly ModelProfile[] = BUILTIN_LOCAL_PROFILES): ProfileRegistry {
  const byId = new Map<string, ModelProfile>();
  for (const p of [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES, ...extra]) byId.set(p.id, p);
  return new ProfileRegistry([...byId.values()]);
}

/** The provider a profile is shown and prechecked under: local profiles (provider `openai-compat` + `local`) are Ollama's. */
export function displayProvider(p: Pick<ModelProfile, "provider" | "local" | "billing">): ProviderId {
  return profileKind(p) === "local" ? "ollama" : (p.provider as ProviderId);
}

/** The static defaults (Anthropic API), used when no provider is ready. */
export function defaultModels(): Record<AgentRoleId, string> {
  const r = DEFAULT_ROUTING.roles;
  return { designer: r.designer.model, judge: r.judge.model, triage: r.triage.model, spec_writer: r.spec_writer.model };
}

// ─── Readiness, availability and auto defaults ────────────────────────────────────────────────

/** What is set up on this machine right now. */
export interface ProviderReadiness {
  cli: ReadonlyMap<CliProviderId, CliProviderStatus>;
  local: LocalProviderStatus | null;
  hasKey(p: ApiProviderId): boolean;
}

export const NO_READINESS: ProviderReadiness = { cli: new Map(), local: null, hasKey: () => false };

export function readinessFrom(cli: readonly CliProviderStatus[], local: LocalProviderStatus | null, keys: KeyResolver | null): ProviderReadiness {
  return {
    cli: new Map(cli.map((s) => [s.id, s])),
    local,
    hasKey: (p) => (p === "openai-compat" ? true : keys?.status(p).source != null),
  };
}

/** Why a CLI cannot run now (for precheck messages and disabled pickers), or null when it can. */
export function cliProblem(status: CliProviderStatus | undefined, provider: CliProviderId): { code: "CLI_NOT_INSTALLED" | "CLI_UNSUPPORTED" | "CLI_BLOCKED" | "CLI_NOT_LOGGED_IN"; reason: string; fix: string } | null {
  const label = status?.label ?? providerLabel(provider);
  if (!status || status.support === "not_installed") {
    return { code: "CLI_NOT_INSTALLED", reason: `${label} is not installed`, fix: `Install it (or set its path in Settings), then press Re-check` };
  }
  if (status.support === "unsupported_version") return { code: "CLI_UNSUPPORTED", reason: `${label} ${status.version ?? ""} cannot be used (${status.supportDetail})`.replace("  ", " "), fix: "Update it, then press Re-check in Settings" };
  if (status.support === "blocked") {
    return /lockdown violation/i.test(status.supportDetail)
      ? { code: "CLI_BLOCKED", reason: `${label} is blocked: a run caught it using a tool it must not have`, fix: "Press Re-check in Settings to test it again, or pick another model" }
      : { code: "CLI_BLOCKED", reason: `${label} is not supported yet (${status.supportDetail})`, fix: "Pick another model in Settings" };
  }
  if (status.auth === "logged_out") return { code: "CLI_NOT_LOGGED_IN", reason: `${label} is installed but not logged in`, fix: `${status.loginHint}, then press Re-check` };
  return null;
}

/** Whether a run could use a profile now, and why not. */
export function profileAvailability(p: ModelProfile, r: ProviderReadiness): { available: boolean; reason?: string } {
  const kind = profileKind(p);
  if (kind === "local") {
    const tag = p.local?.tag ?? p.apiModelId;
    if (!r.local?.running) return { available: false, reason: "Ollama is not running" };
    const m = r.local.models.find((x) => x.tag === tag);
    if (!m) return { available: false, reason: `not pulled: run \`ollama pull ${tag}\`` };
    if (!m.tools) return { available: false, reason: "no tool calling" };
    return { available: true };
  }
  if (kind === "cli" && isCliProviderId(p.provider)) {
    const problem = cliProblem(r.cli.get(p.provider), p.provider);
    if (problem) return { available: false, reason: problem.reason };
    if (p.cli && !p.cli.modes.includes("completion") && !p.cli.modes.includes("runtime")) return { available: false, reason: "no supported mode" };
    return { available: true };
  }
  if (isApiProviderId(p.provider) && !r.hasKey(p.provider)) return { available: false, reason: `no ${providerLabel(p.provider)} API key` };
  return { available: true };
}

/** A CLI that is ready and logged in (auto defaults need a known login). */
function cliReady(r: ProviderReadiness, p: CliProviderId): boolean {
  const s = r.cli.get(p);
  return !!s && s.support === "ready" && s.auth === "logged_in";
}

export interface AutoDefaults {
  models: Record<AgentRoleId, string>;
  /** The provider they come from; null when nothing is set up (the static Anthropic defaults). */
  provider: ProviderId | null;
}

type RoleTable = Omit<Record<AgentRoleId, string>, "judge"> & { judge: string | null };

const ROLE_TABLES: Partial<Record<ProviderId, RoleTable>> = {
  "claude-cli": { designer: "claude-cli:opus", spec_writer: "claude-cli:opus", triage: "claude-cli:haiku", judge: "claude-cli:fable" },
  "codex-cli": { designer: "codex-cli:gpt-6-sol", spec_writer: "codex-cli:gpt-6-sol", triage: "codex-cli:gpt-6-luna", judge: null },
  "gemini-cli": { designer: "gemini-cli:pro", spec_writer: "gemini-cli:pro", triage: "gemini-cli:flash-lite", judge: null },
  anthropic: { ...defaultModels() },
  openai: { designer: "gpt-6-sol", spec_writer: "gpt-6-sol", triage: "gpt-6-luna", judge: null },
  google: { designer: "gemini-3.1-pro-preview", spec_writer: "gemini-3.1-pro-preview", triage: "gemini-3.5-flash-lite", judge: null },
};

/** The first ready provider's role table (§9.3), with a judge from another ready provider's family when it has none. */
export function autoDefaults(r: ProviderReadiness, registry: ProfileRegistry): AutoDefaults {
  const order: ProviderId[] = ["claude-cli", "codex-cli", "gemini-cli", "opencode", "anthropic", "openai", "google", "ollama"];
  const tables: Array<{ provider: ProviderId; table: RoleTable }> = [];
  for (const provider of order) {
    let table: RoleTable | null = null;
    if (isCliProviderId(provider)) {
      if (!cliReady(r, provider)) continue;
      table = ROLE_TABLES[provider] ?? null;
      if (table === null) {
        // opencode has no static profiles: its first discovered model plays every role.
        const first = registry.list().find((p) => p.provider === provider && profileAvailability(p, r).available);
        if (first) table = { designer: first.id, spec_writer: first.id, triage: first.id, judge: null };
      }
    } else if (provider === "ollama") {
      const first = registry.list().find((p) => profileKind(p) === "local" && profileAvailability(p, r).available);
      if (first) table = { designer: first.id, spec_writer: first.id, triage: first.id, judge: null };
    } else if (isApiProviderId(provider) && r.hasKey(provider)) {
      table = ROLE_TABLES[provider] ?? null;
    }
    if (table && [table.designer, table.spec_writer, table.triage].every((id) => registry.has(id))) tables.push({ provider, table });
  }
  let chosen = tables[0];
  if (!chosen) {
    // Nothing is ready, but a supported CLI is installed and only needs a login, or a Re-check after a lockdown block:
    // default to it anyway, so a run says "log in to Claude Code" or "press Re-check" (the fix the user most likely
    // wants) rather than asking for an API key.
    const waiting = (["claude-cli", "codex-cli", "gemini-cli"] as const).find((p) => {
      const s = r.cli.get(p);
      return s?.support === "ready" || (s?.support === "blocked" && /lockdown violation/i.test(s.supportDetail));
    });
    const table = waiting ? ROLE_TABLES[waiting] : undefined;
    if (!waiting || !table) return { models: defaultModels(), provider: null };
    chosen = { provider: waiting, table };
  }
  const designerFamily = registry.get(chosen.table.designer).family;
  let judge = chosen.table.judge;
  if (judge === null || !registry.has(judge)) {
    judge = tables.slice(1).map((t) => t.table.judge ?? t.table.designer).find((id) => registry.has(id) && registry.get(id).family !== designerFamily) ?? chosen.table.designer;
  }
  return { models: { designer: chosen.table.designer, spec_writer: chosen.table.spec_writer, triage: chosen.table.triage, judge }, provider: chosen.provider };
}

/** Effective model per role from the stored overrides (see the module doc). */
export function effectiveModels(stored: StoredSettings, registry: ProfileRegistry, defaults: Record<AgentRoleId, string> = defaultModels()): Record<AgentRoleId, string> {
  const d = defaults;
  const known = (id: string | undefined): string | undefined => (id !== undefined && registry.has(id) ? id : undefined);
  const designer = known(stored.models.designer) ?? d.designer;
  const designerOverridden = known(stored.models.designer) !== undefined;
  const spec = known(stored.models.spec_writer) ?? (designerOverridden ? designer : d.spec_writer);
  let triage = known(stored.models.triage);
  if (triage === undefined) {
    if (designerOverridden) {
      const small = smallModelForProfile(registry.get(designer));
      triage = small !== null && registry.has(small) ? small : designer;
    } else triage = d.triage;
  }
  return { designer, spec_writer: spec, triage, judge: known(stored.models.judge) ?? d.judge };
}

/** Gateway routing for the effective models (efforts and token limits from the default route of each role). */
export function routingFor(models: Record<AgentRoleId, string>): RoutingConfig {
  const base = DEFAULT_ROUTING.roles;
  const route = (role: AgentRoleId) => ({ ...base[role], model: models[role] });
  return { ...DEFAULT_ROUTING, roles: { ...base, designer: route("designer"), spec_writer: route("spec_writer"), triage: route("triage"), judge: route("judge") } };
}

/** The roles a run calls (the judge is not called until the L5 visual review exists). */
export const RUN_ROLES = ["designer", "spec_writer", "triage"] as const;

/** API-key providers a run needs keys for (CLI and local providers need none). */
export function providersForRun(models: Record<AgentRoleId, string>, registry: ProfileRegistry): ApiProviderId[] {
  const set = new Set<ApiProviderId>();
  for (const role of RUN_ROLES) {
    const p = registry.get(models[role]);
    if (profileKind(p) === "api" && isApiProviderId(p.provider)) set.add(p.provider);
  }
  return [...set];
}

// ─── Store ───────────────────────────────────────────────────────────────────────────────────

function sanitize(v: unknown): StoredSettings {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const models: StoredSettings["models"] = {};
  const m = (typeof o["models"] === "object" && o["models"] !== null ? o["models"] : {}) as Record<string, unknown>;
  for (const role of ROLE_IDS) if (typeof m[role] === "string" && (m[role] as string).length <= 200) models[role] = m[role] as string;
  const b = o["budgetUsd"];
  const budgetUsd = typeof b === "number" && Number.isFinite(b) && b >= MIN_BUDGET_USD && b <= MAX_BUDGET_USD ? b : DEFAULT_BUDGET_USD;
  // The same rule as a Settings update (https, or http on loopback): a hand-edited file cannot
  // send the key and the design over cleartext to a remote host.
  const url = (raw: unknown): string | null => (typeof raw === "string" && raw.length <= 500 && baseUrlProblem(raw) === null ? raw : null);
  const cliPaths: StoredSettings["cliPaths"] = {};
  const cp = (typeof o["cliPaths"] === "object" && o["cliPaths"] !== null ? o["cliPaths"] : {}) as Record<string, unknown>;
  // The same shape rule as a Settings update (absolute, the CLI's own name): a hand-edited file cannot point a
  // provider at another program. Whether the file exists and is executable is checked again by detection before
  // every use (`cli-detect.ts`), so a CLI that is missing for now is reported instead of silently forgotten.
  for (const id of CLI_PROVIDER_IDS) {
    const path = cp[id];
    if (typeof path !== "string" || path.length > 1024) continue;
    if (cliPathShapeProblem(path, CLI_PROVIDERS.get(id)?.binaryNames ?? []) === null) cliPaths[id] = path;
  }
  const mode = o["cliMode"];
  return {
    v: 1,
    models,
    budgetUsd,
    compatBaseUrl: url(o["compatBaseUrl"]),
    cliPaths,
    cliMode: typeof mode === "string" && (CLI_MODES as readonly string[]).includes(mode) ? (mode as CliModeSetting) : "auto",
    ollamaBaseUrl: url(o["ollamaBaseUrl"]),
    autonomy: typeof o["autonomy"] === "string" && (AUTONOMY_SETTINGS as readonly string[]).includes(o["autonomy"]) ? (o["autonomy"] as AutonomySetting) : "review",
    cliBlocks: sanitizeBlocks(o["cliBlocks"]),
  };
}

/** Well-formed blocks, the newest {@link MAX_CLI_BLOCKS} (blocks are appended: the newest is last). */
function sanitizeBlocks(v: unknown): CliBlock[] {
  if (!Array.isArray(v)) return [];
  const out: CliBlock[] = [];
  for (const raw of v.slice(-4 * MAX_CLI_BLOCKS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw as Record<string, unknown>;
    const { provider, realPath, size, mtimeMs, reason, at } = b;
    if (typeof provider !== "string" || !isCliProviderId(provider)) continue;
    if (typeof realPath !== "string" || realPath.length === 0 || realPath.length > 4096) continue;
    if (typeof size !== "number" || !Number.isFinite(size) || typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) continue;
    out.push({ provider, realPath, size, mtimeMs, reason: typeof reason === "string" ? reason.slice(0, 300) : "", at: typeof at === "string" ? at.slice(0, 40) : "" });
  }
  return out.slice(-MAX_CLI_BLOCKS);
}

export class SettingsStore {
  readonly file: string;
  #data: StoredSettings;

  constructor(file: string) {
    this.file = file;
    let data = DEFAULTS;
    try {
      if (existsSync(file)) data = sanitize(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      data = DEFAULTS;
    }
    this.#data = data;
  }

  get(): StoredSettings {
    return this.#data;
  }

  /** Apply a validated update; unknown model ids are rejected. */
  update(u: SettingsUpdate, registry: ProfileRegistry): StoredSettings {
    const models = { ...this.#data.models };
    for (const [role, model] of Object.entries(u.models ?? {}) as Array<[AgentRoleId, string | null]>) {
      if (model === null) delete models[role];
      else if (!registry.has(model)) throw new Error(`unknown model profile: ${model}`);
      else models[role] = model;
    }
    const cliPaths = { ...this.#data.cliPaths };
    for (const [id, path] of Object.entries(u.cliPaths ?? {}) as Array<[CliProviderId, string | null]>) {
      if (path === null) delete cliPaths[id];
      else cliPaths[id] = path;
    }
    this.#data = {
      v: 1,
      models,
      budgetUsd: u.budgetUsd ?? this.#data.budgetUsd,
      compatBaseUrl: u.compatBaseUrl === undefined ? this.#data.compatBaseUrl : u.compatBaseUrl,
      cliPaths,
      cliMode: u.cliMode ?? this.#data.cliMode,
      ollamaBaseUrl: u.ollamaBaseUrl === undefined ? this.#data.ollamaBaseUrl : u.ollamaBaseUrl,
      autonomy: u.autonomy ?? this.#data.autonomy,
      cliBlocks: this.#data.cliBlocks,
    };
    this.#save();
    return this.#data;
  }

  /** Replace the blocked CLI binaries (the detector's own list; not a renderer update). */
  setCliBlocks(blocks: readonly CliBlock[]): void {
    this.#data = { ...this.#data, cliBlocks: sanitizeBlocks(blocks) };
    this.#save();
  }

  #save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`, "utf8");
    renameSync(tmp, this.file);
  }
}

// ─── View ────────────────────────────────────────────────────────────────────────────────────

const GROUP_ORDER: ProviderId[] = ["claude-cli", "codex-cli", "gemini-cli", "opencode", "cursor-agent", "ollama", "anthropic", "openai", "google", "openai-compat"];

export function profileInfo(p: ModelProfile, r: ProviderReadiness): ModelProfileInfo {
  const kind = profileKind(p) as ProviderKindId;
  const a = profileAvailability(p, r);
  return {
    id: p.id,
    name: p.displayName,
    provider: displayProvider(p),
    family: p.family,
    kind,
    billing: (p.billing ?? "metered") as BillingKind,
    available: a.available,
    ...(a.reason === undefined ? {} : { reason: a.reason }),
  };
}

/** Routing warnings (judge family rule) for the effective models. */
export function routingWarnings(models: Record<AgentRoleId, string>, registry: ProfileRegistry): string[] {
  try {
    const router = new Router(registry, routingFor(models), () => undefined);
    return router.warnings.map((w) => w.message);
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
}

export interface SettingsViewInput {
  stored: StoredSettings;
  keys: KeyResolver;
  transport: AgentTransportKind;
  registry?: ProfileRegistry;
  cli?: readonly CliProviderStatus[];
  local?: LocalProviderStatus | null;
  /** Local model server base URL shown in Settings. */
  ollamaBaseUrl?: string | null;
  /** Extra warnings (e.g. a cached plan limit). */
  warnings?: readonly string[];
}

/** What the renderer may know about the settings: no keys, only their status; no CLI credentials at all. */
export function buildSettingsView(input: SettingsViewInput): AgentSettingsView {
  const { stored, keys, transport } = input;
  const registry = input.registry ?? profileRegistry();
  const readiness = readinessFrom(input.cli ?? [], input.local ?? null, keys);
  const auto = autoDefaults(readiness, registry);
  const models = effectiveModels(stored, registry, auto.models);
  const order = (p: ProviderId): number => GROUP_ORDER.indexOf(p);
  return {
    v: PROTOCOL_VERSION,
    providers: PROVIDERS.map((p) => {
      const st = keys.status(p.id);
      return { id: p.id, label: p.label, configured: st.source !== null, source: st.source, last4: st.last4, envVar: p.envVars[0]!, keyRequired: p.keyRequired };
    }),
    secureStorage: keys.store.secureStorage(),
    ...(keys.store.enabled ? {} : { apiKeysEnabled: false }),
    models,
    defaults: auto.models,
    profiles: registry
      .list()
      .map((p) => profileInfo(p, readiness))
      .sort((a, b) => order(a.provider) - order(b.provider) || a.name.localeCompare(b.name)),
    budgetUsd: stored.budgetUsd,
    compatBaseUrl: stored.compatBaseUrl,
    transport,
    warnings: [...routingWarnings(models, registry), ...(input.warnings ?? [])],
    cli: [...(input.cli ?? [])],
    local: input.local ? [input.local] : [],
    cliMode: stored.cliMode,
    autoDefault: auto.provider === null ? null : { provider: auto.provider, label: providerLabel(auto.provider) },
    ollamaBaseUrl: stored.ollamaBaseUrl,
    autonomy: stored.autonomy,
  };
}

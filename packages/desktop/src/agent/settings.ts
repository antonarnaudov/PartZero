/**
 * Agent settings that are not secret: the model per role, the per-task budget and the base URL of
 * an OpenAI-compatible endpoint. Stored as JSON in `<userData>/agent-settings.json`; keys are
 * in `keys.ts`, never here.
 *
 * Model resolution mirrors `@aicad/agent` `resolveModels`: when only the designer is overridden,
 * the spec writer follows it and triage uses that provider's small model, so switching the designer
 * to another provider needs exactly one key.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AgentRoleId, AgentSettingsView, AgentTransportKind, ModelProfileInfo, ProviderId, SettingsUpdate } from "@aicad/app/bridge";
import { BUILTIN_PROFILES, DEFAULT_ROUTING, ProfileRegistry, Router, type ModelProfile, type RoutingConfig } from "@aicad/llm-gateway";
import { PROVIDERS, type KeyResolver } from "./keys.js";
import { baseUrlProblem, MAX_BUDGET_USD, MIN_BUDGET_USD, PROTOCOL_VERSION, ROLE_IDS } from "./protocol.js";

export const DEFAULT_BUDGET_USD = 1.0;

/** Small, fast model per provider (triage). Same table as `@aicad/agent` `SMALL_MODEL_BY_PROVIDER` (checked by a test). */
export const SMALL_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-6-luna",
  google: "gemini-3.5-flash-lite",
};

export interface StoredSettings {
  v: 1;
  models: Partial<Record<AgentRoleId, string>>;
  budgetUsd: number;
  compatBaseUrl: string | null;
}

const DEFAULTS: StoredSettings = { v: 1, models: {}, budgetUsd: DEFAULT_BUDGET_USD, compatBaseUrl: null };

/** The profile registry the app offers (built-in profiles; config overrides later). */
export function profileRegistry(): ProfileRegistry {
  return new ProfileRegistry(BUILTIN_PROFILES);
}

export function defaultModels(): Record<AgentRoleId, string> {
  const r = DEFAULT_ROUTING.roles;
  return { designer: r.designer.model, judge: r.judge.model, triage: r.triage.model, spec_writer: r.spec_writer.model };
}

/** Effective model per role from the stored overrides (see the module doc). */
export function effectiveModels(stored: StoredSettings, registry: ProfileRegistry): Record<AgentRoleId, string> {
  const d = defaultModels();
  const known = (id: string | undefined): string | undefined => (id !== undefined && registry.has(id) ? id : undefined);
  const designer = known(stored.models.designer) ?? d.designer;
  const designerOverridden = known(stored.models.designer) !== undefined;
  const spec = known(stored.models.spec_writer) ?? (designerOverridden ? designer : d.spec_writer);
  let triage = known(stored.models.triage);
  if (triage === undefined) {
    if (designerOverridden) {
      const small = SMALL_MODEL_BY_PROVIDER[registry.get(designer).provider];
      triage = small !== undefined && registry.has(small) ? small : designer;
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

/** Providers a run needs keys for (the judge is not called until the L5 visual review exists). */
export function providersForRun(models: Record<AgentRoleId, string>, registry: ProfileRegistry): ProviderId[] {
  const set = new Set<ProviderId>();
  for (const role of ["designer", "spec_writer", "triage"] as const) set.add(registry.get(models[role]).provider);
  return [...set];
}

function sanitize(v: unknown): StoredSettings {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const models: StoredSettings["models"] = {};
  const m = (typeof o["models"] === "object" && o["models"] !== null ? o["models"] : {}) as Record<string, unknown>;
  for (const role of ROLE_IDS) if (typeof m[role] === "string" && (m[role] as string).length <= 100) models[role] = m[role] as string;
  const b = o["budgetUsd"];
  const budgetUsd = typeof b === "number" && Number.isFinite(b) && b >= MIN_BUDGET_USD && b <= MAX_BUDGET_USD ? b : DEFAULT_BUDGET_USD;
  // The same rule as a Settings update (https, or http on loopback): a hand-edited file cannot
  // send the key and the design over cleartext to a remote host.
  const rawUrl = o["compatBaseUrl"];
  const url = typeof rawUrl === "string" && rawUrl.length <= 500 && baseUrlProblem(rawUrl) === null ? rawUrl : null;
  return { v: 1, models, budgetUsd, compatBaseUrl: url };
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
    this.#data = {
      v: 1,
      models,
      budgetUsd: u.budgetUsd ?? this.#data.budgetUsd,
      compatBaseUrl: u.compatBaseUrl === undefined ? this.#data.compatBaseUrl : u.compatBaseUrl,
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`, "utf8");
    renameSync(tmp, this.file);
    return this.#data;
  }
}

function profileInfo(p: ModelProfile): ModelProfileInfo {
  return { id: p.id, name: p.displayName, provider: p.provider, family: p.family };
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

/** What the renderer may know about the settings: no keys, only their status. */
export function buildSettingsView(stored: StoredSettings, keys: KeyResolver, transport: AgentTransportKind, registry: ProfileRegistry = profileRegistry()): AgentSettingsView {
  const models = effectiveModels(stored, registry);
  return {
    v: PROTOCOL_VERSION,
    providers: PROVIDERS.map((p) => {
      const st = keys.status(p.id);
      return { id: p.id, label: p.label, configured: st.source !== null, source: st.source, last4: st.last4, envVar: p.envVars[0]!, keyRequired: p.keyRequired };
    }),
    secureStorage: keys.store.secureStorage(),
    models,
    defaults: defaultModels(),
    profiles: registry
      .list()
      .map(profileInfo)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)),
    budgetUsd: stored.budgetUsd,
    compatBaseUrl: stored.compatBaseUrl,
    transport,
    warnings: routingWarnings(models, registry),
  };
}

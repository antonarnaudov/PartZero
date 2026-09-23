/**
 * Which model plays which role. Defaults come from the gateway's router (ARCHITECTURE §6 "Roles",
 * configured from the eval leaderboard). A bake-off overrides the designer only: the spec writer
 * then uses the same model (one model family per run), and triage the provider's small model, so
 * a run needs exactly one provider key.
 */
import type { LLMGateway, ReasoningEffort } from "@aicad/llm-gateway";

export type AgentRole = "triage" | "designer" | "spec_writer";
export const AGENT_ROLES: readonly AgentRole[] = ["triage", "designer", "spec_writer"];

export interface ModelChoice {
  /** Gateway profile id. */
  model: string;
  effort?: ReasoningEffort;
  maxOutputTokens?: number;
}

export type AgentModels = Record<AgentRole, ModelChoice>;

export type ModelOverrides = Partial<Record<AgentRole, string | ModelChoice>>;

/** The small, fast model per provider (triage). */
export const SMALL_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-6-luna",
  google: "gemini-3.5-flash-lite",
};

/** Output-token ceilings per role (thinking counts against them). */
export const DEFAULT_MAX_OUTPUT_TOKENS: Readonly<Record<AgentRole, number>> = {
  triage: 1024,
  spec_writer: 12_000,
  designer: 16_000,
};

const DEFAULT_EFFORT: Readonly<Partial<Record<AgentRole, ReasoningEffort>>> = { designer: "medium", spec_writer: "high" };

function choice(v: string | ModelChoice): ModelChoice {
  return typeof v === "string" ? { model: v } : v;
}

export function resolveModels(gateway: LLMGateway, overrides: ModelOverrides = {}): AgentModels {
  const fromRouter = (role: AgentRole): ModelChoice => {
    const r = gateway.router.resolve(role);
    return { model: r.model, ...(r.effort === undefined ? {} : { effort: r.effort }), ...(r.maxOutputTokens === undefined ? {} : { maxOutputTokens: r.maxOutputTokens }) };
  };
  const designer = overrides.designer !== undefined ? choice(overrides.designer) : fromRouter("designer");
  const designerOverridden = overrides.designer !== undefined;
  let spec: ModelChoice;
  if (overrides.spec_writer !== undefined) spec = choice(overrides.spec_writer);
  else if (designerOverridden) spec = { model: designer.model };
  else spec = fromRouter("spec_writer");
  let triage: ModelChoice;
  if (overrides.triage !== undefined) triage = choice(overrides.triage);
  else if (designerOverridden) {
    const small = SMALL_MODEL_BY_PROVIDER[gateway.profile(designer.model).provider];
    triage = { model: small !== undefined && gateway.registry.has(small) ? small : designer.model };
  } else triage = fromRouter("triage");

  const out: AgentModels = { triage, designer, spec_writer: spec };
  for (const role of AGENT_ROLES) {
    gateway.profile(out[role].model); // unknown ids fail fast
    const c = { ...out[role] };
    if (c.effort === undefined && DEFAULT_EFFORT[role] !== undefined) c.effort = DEFAULT_EFFORT[role];
    c.maxOutputTokens ??= DEFAULT_MAX_OUTPUT_TOKENS[role];
    out[role] = c;
  }
  return out;
}

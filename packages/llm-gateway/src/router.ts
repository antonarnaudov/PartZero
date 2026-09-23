import { z } from "zod";
import { GatewayError } from "./errors.js";
import type { ProfileRegistry } from "./profile.js";
import type { ModelRef, ReasoningEffort } from "./types.js";

/** Agent roles (ARCHITECTURE §6 "Roles"). Routing is configuration, fed by the eval leaderboard (ADR 0009). */
export const ROLES = ["triage", "designer", "spec_writer", "judge", "advisor", "economy"] as const;
export type Role = (typeof ROLES)[number];

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const roleRouteSchema = z.object({
  model: z.string().min(1),
  effort: effort.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

export const routingConfigSchema = z.object({
  roles: z.object(Object.fromEntries(ROLES.map((r) => [r, roleRouteSchema])) as Record<Role, typeof roleRouteSchema>),
  /**
   * The judge must come from a different model family than the designer (CADSmith result, ADR 0009).
   * `family` compares `profile.family` (claude-opus vs claude-fable are different families, per ARCHITECTURE §6
   * defaults); `vendor` is stricter (different company); `off` disables the check.
   */
  judgeRule: z.enum(["family", "vendor", "off"]).default("family"),
  /** Throw on rule violations instead of warning. */
  strict: z.boolean().default(false),
});

export type RoleRoute = z.infer<typeof roleRouteSchema>;
export type RoutingConfig = z.input<typeof routingConfigSchema>;

/** Defaults as of Sept 2026 (ARCHITECTURE §6 "Roles", Anthropic column). Replace from the leaderboard via config. */
export const DEFAULT_ROUTING: RoutingConfig = {
  roles: {
    triage: { model: "claude-haiku-4-5" },
    designer: { model: "claude-opus-5-5", effort: "medium" },
    spec_writer: { model: "claude-opus-5-5", effort: "high" },
    judge: { model: "claude-fable-5-1", effort: "high" },
    advisor: { model: "claude-opus-5-5", effort: "medium" },
    economy: { model: "claude-sonnet-5", effort: "medium" },
  },
  judgeRule: "family",
  strict: false,
};

export interface RouteTarget {
  role: Role;
  model: ModelRef;
  effort?: ReasoningEffort;
  maxOutputTokens?: number;
}

export interface RoutingWarning {
  code: "judge_same_family" | "judge_same_vendor";
  message: string;
}

export class Router {
  readonly #config: z.output<typeof routingConfigSchema>;
  readonly #registry: ProfileRegistry;
  readonly warnings: RoutingWarning[];

  constructor(registry: ProfileRegistry, config: RoutingConfig = DEFAULT_ROUTING, onWarning: (w: RoutingWarning) => void = defaultWarn) {
    const parsed = routingConfigSchema.safeParse(config);
    if (!parsed.success) throw new GatewayError("config", `Invalid routing config: ${z.prettifyError(parsed.error)}`);
    this.#config = parsed.data;
    this.#registry = registry;
    for (const role of ROLES) registry.get(this.#config.roles[role].model); // unknown ids fail fast
    this.warnings = this.validate();
    if (this.warnings.length > 0 && this.#config.strict) {
      throw new GatewayError("config", this.warnings.map((w) => w.message).join("; "));
    }
    for (const w of this.warnings) onWarning(w);
  }

  /** Check routing rules; returns violations (does not throw). */
  validate(): RoutingWarning[] {
    const rule = this.#config.judgeRule;
    if (rule === "off") return [];
    const designer = this.#registry.get(this.#config.roles.designer.model);
    const judge = this.#registry.get(this.#config.roles.judge.model);
    if (rule === "vendor" && designer.vendor === judge.vendor) {
      return [
        {
          code: "judge_same_vendor",
          message: `judge '${judge.id}' and designer '${designer.id}' are both from vendor '${judge.vendor}'; the judge should come from a different vendor`,
        },
      ];
    }
    if (designer.family === judge.family) {
      return [
        {
          code: "judge_same_family",
          message: `judge '${judge.id}' and designer '${designer.id}' are both in model family '${judge.family}'; the judge should come from a different family`,
        },
      ];
    }
    return [];
  }

  resolve(role: Role): RouteTarget {
    const route = this.#config.roles[role];
    if (route === undefined) throw new GatewayError("unknown_role", `Unknown role '${String(role)}'`);
    const target: RouteTarget = { role, model: route.model };
    if (route.effort !== undefined) target.effort = route.effort;
    if (route.maxOutputTokens !== undefined) target.maxOutputTokens = route.maxOutputTokens;
    return target;
  }

  get config(): z.output<typeof routingConfigSchema> {
    return this.#config;
  }
}

function defaultWarn(w: RoutingWarning): void {
  console.warn(`[llm-gateway] routing: ${w.message}`);
}

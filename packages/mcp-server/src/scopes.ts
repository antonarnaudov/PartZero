/**
 * Scope → tool names (FROZEN scopes: CLI-PROVIDERS.md §6.3; external scopes: ARCHITECTURE §9).
 *
 * | Scope        | Tools                                                     | Used by                          |
 * |--------------|-----------------------------------------------------------|----------------------------------|
 * | `spec`       | `set_spec_tests`, `submit_spec`                           | runtime SPEC                     |
 * | `design`     | `DESIGNER_TOOLS` (without `ask_user` when the CLI's call   | runtime BUILD                    |
 * |              | timeout is shorter than the question wait)                |                                  |
 * | `read`       | `READ_ONLY_TOOLS`                                         | runtime ASK                      |
 * | `submit`     | `submit_turn` (envelope schema, built by the gateway)     | completion mode, `mcp-submit`    |
 * | `ext-read`   | `READ_ONLY_TOOLS`                                         | external clients                 |
 * | `ext-edit`   | `DESIGNER_TOOLS` without `ask_user` (on an `mcp/<client>`  | external clients                 |
 * |              | branch; the external agent talks to its own user)         |                                  |
 * | `ext-export` | `export_design` (writes only inside the export directory) | external clients                 |
 */
import { DESIGNER_TOOLS, READ_ONLY_TOOLS, SPEC_WRITER_TOOLS, type DesignToolContext, type ToolRegistry } from "@aicad/agent-tools";
import type { McpScope, McpToolDef } from "./types.js";

export const SUBMIT_TURN_TOOL = "submit_turn";
export const EXPORT_TOOL = "export_design";

/** The longest the host waits for the user's answer to `ask_user` (CLI-PROVIDERS.md §3.3). */
export const CLI_QUESTION_WAIT_MS = 600_000;

/** Tools whose handler may wait for the user (their wait does not count against the handler timeout). */
export const USER_WAIT_TOOLS: ReadonlySet<string> = new Set(["ask_user"]);

/**
 * The most user-wait time one call may exclude from its handler deadline: the question wait plus room
 * for a budget-checkpoint prompt. With the 120 s handler time this stays under the 900 s CLI call timeout.
 */
export const MAX_USER_WAIT_PER_CALL_MS = CLI_QUESTION_WAIT_MS + 120_000;

export interface ScopeOptions {
  /**
   * `design` only: keep `ask_user`. The runtime passes `maxToolCallMs > CLI_QUESTION_WAIT_MS + 30_000`
   * for the CLI in use; default true.
   */
  askUser?: boolean;
}

/** The bare tool names a scope exposes, sorted. */
export function scopeToolNames(scope: McpScope, options: ScopeOptions = {}): string[] {
  const without = (names: readonly string[], drop: string) => names.filter((n) => n !== drop);
  let names: readonly string[];
  switch (scope) {
    case "spec":
      names = SPEC_WRITER_TOOLS;
      break;
    case "design":
      names = options.askUser === false ? without(DESIGNER_TOOLS, "ask_user") : DESIGNER_TOOLS;
      break;
    case "read":
    case "ext-read":
      names = READ_ONLY_TOOLS;
      break;
    case "submit":
      names = [SUBMIT_TURN_TOOL];
      break;
    case "ext-edit":
      names = without(DESIGNER_TOOLS, "ask_user");
      break;
    case "ext-export":
      names = [EXPORT_TOOL];
      break;
  }
  return [...names].sort();
}

/** True when `ask_user` may stay in the design scope for a CLI whose MCP call timeout is `maxToolCallMs`. */
export function askUserFits(maxToolCallMs: number): boolean {
  return maxToolCallMs > CLI_QUESTION_WAIT_MS + 30_000;
}

/**
 * Strict tool definitions for `names` straight from the agent-tools registry (the same schema bytes the
 * API adapters see), with `readOnly` taken from the registry's tools. Unknown names throw.
 */
export function registryToolDefs(registry: ToolRegistry<DesignToolContext>, names: readonly string[]): McpToolDef[] {
  return registry
    .subset(names)
    .defs()
    .map((d) => ({ ...d, readOnly: registry.get(d.name)?.readOnly === true }));
}

/**
 * Every definition with `readOnly` set: kept when the caller set it, otherwise true exactly for the
 * registry's `READ_ONLY_TOOLS`. `ToolRegistry.defs()` leaves `readOnly` out; without this, passing it
 * straight to the host would mark every tool `readOnlyHint: false` (§6.2).
 */
export function withReadOnly(defs: readonly McpToolDef[]): McpToolDef[] {
  const readOnly: ReadonlySet<string> = new Set(READ_ONLY_TOOLS);
  return defs.map((d) => (typeof d.readOnly === "boolean" ? d : { ...d, readOnly: readOnly.has(d.name) }));
}

/** Scopes whose tools must all be read-only. */
export const READ_SCOPES: ReadonlySet<McpScope> = new Set(["read", "ext-read"]);

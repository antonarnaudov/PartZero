/**
 * The command layer's ops over MCP (FULL-MODELING-PLAN §2.1 rule 3): the `ops` scope (the in-app
 * agent operating the live document) and `ext-ops` (an external MCP client operating a document the
 * host shares), with the tools of `@aicad/agent-tools` `opTools()` — themselves generated from the
 * `@aicad/model-ops` catalogue — bound to an {@link OpsHost}. Every call is one transaction as the
 * host's origin (`agent`, `mcp:<client>`): authorship, ADR 0015's commit check and the failure rule
 * apply exactly as in the app.
 *
 * `ops-read` is the read-only subset (`get_model`, `get_feature`, `feature_dependents`, `ref_for`, `feasible_range`,
 * `param_uses`).
 */
import { OPS_READ_TOOLS, OPS_TOOLS, opsRegistry, type OpsToolContext, type ToolRegistry } from "@aicad/agent-tools";
import type { OpsHost } from "@aicad/model-ops";
import type { McpToolCall, McpToolDef, McpToolResult } from "./types.js";

/** Strict tool definitions of the op tools (`names`, default all), with `readOnly` from the registry. */
export function opsToolDefs(names: readonly string[] = OPS_TOOLS, registry: ToolRegistry<OpsToolContext> = opsRegistry()): McpToolDef[] {
  return registry
    .subset(names)
    .defs()
    .map((d) => ({ ...d, readOnly: registry.get(d.name)?.readOnly === true }));
}

export interface OpsHandlerOptions {
  host: OpsHost;
  /** Read-only scopes: tools that change the model refuse (they are not offered either). */
  readOnly?: boolean;
  registry?: ToolRegistry<OpsToolContext>;
  /** Every executed call (transcripts, the live agent's narration). */
  onResult?(call: McpToolCall, result: McpToolResult): void;
}

/** A broker handler that runs the op tools on `host`. */
export function opsHandler(options: OpsHandlerOptions): (call: McpToolCall) => Promise<McpToolResult> {
  const registry = options.registry ?? opsRegistry();
  const ctx: OpsToolContext = { ops: options.host, ...(options.readOnly ? { readOnly: true } : {}) };
  return async (call) => {
    const out = await registry.execute({ ...(call.toolUseId ? { id: call.toolUseId } : {}), name: call.name, input: call.args }, ctx);
    const result: McpToolResult = { text: out.text, isError: out.isError === true };
    options.onResult?.(call, result);
    return result;
  };
}

export { OPS_READ_TOOLS, OPS_TOOLS };

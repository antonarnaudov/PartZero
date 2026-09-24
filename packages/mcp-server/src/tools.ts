/**
 * Registry tool definitions → MCP tools (CLI-PROVIDERS.md §6.2).
 *
 * The input schema is `ToolRegistry.schema(name)` byte for byte (strict draft 2020-12: every object
 * closed, constraint keywords restated in descriptions), so a CLI model sees exactly what the API
 * adapters send. `destructiveHint` is false because every edit lands on a draft branch that the user
 * reviews; `readOnlyHint`/`idempotentHint` come from the definition's `readOnly` flag.
 *
 * `readOnly` must be set: build definitions with `registryToolDefs()` (`ToolRegistry.defs()` leaves it
 * out, and a missing flag reads as false here). `createMcpHost().open()` fills it with `withReadOnly()`
 * and refuses a `read`/`ext-read` scope with a writing tool. This module stays free of the registry so
 * the shim can import it.
 */
import type { BrokerTool } from "./bridge-protocol.js";
import type { McpToolDef } from "./types.js";

/** MCP tool names: the registry's snake_case names (≤ 64). */
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function toBrokerTool(def: McpToolDef): BrokerTool {
  if (!NAME.test(def.name)) throw new Error(`tool name ${JSON.stringify(def.name)} is not a registry name (snake_case, ≤ 64)`);
  const schema = def.inputSchema;
  if (schema["type"] !== "object") throw new Error(`tool ${def.name}: the input schema must be an object schema`);
  const readOnly = def.readOnly === true;
  return {
    name: def.name,
    description: def.description,
    inputSchema: schema,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false },
  };
}

/** Map every definition; names must be unique. Order is kept (the registry already sorts). */
export function toBrokerTools(defs: readonly McpToolDef[]): BrokerTool[] {
  const seen = new Set<string>();
  return defs.map((d) => {
    if (seen.has(d.name)) throw new Error(`duplicate tool ${d.name}`);
    seen.add(d.name);
    return toBrokerTool(d);
  });
}

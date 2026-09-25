/**
 * `@aicad/mcp-server`: the `cad` MCP server (CLI-PROVIDERS.md §6, ADR 0014).
 *
 * - {@link createMcpHost} / {@link startBroker}: the host-side tool broker (implements the gateway's
 *   `CliMcpHost`): per-run ticket, 0700 socket, scopes, FIFO, limits, stop gating, in-memory log.
 * - `aicad-mcp` (`./stdio`): the stdio shim CLI agents launch through their MCP config.
 * - {@link McpConnection} / {@link serveStreams}: the MCP protocol subset over any transport.
 * - {@link toBrokerTools} / {@link registryToolDefs} / {@link scopeToolNames}: tools generated from the
 *   agent-tools registry, per scope.
 * - {@link opsToolDefs} / {@link opsHandler}: the command layer's ops (`ops`, `ext-ops`, `ops-read` scopes) over an
 *   `OpsHost` — the agent operates the modeling tools on the live document.
 * - `@aicad/mcp-server/host`: backends bound to a `DesignSession` (external clients, headless mode).
 */
export * from "./bridge-client.js";
export * from "./bridge-protocol.js";
export * from "./broker.js";
export * from "./jsonrpc.js";
export * from "./mcp.js";
export * from "./ops.js";
export * from "./scopes.js";
export * from "./tools.js";
export * from "./types.js";
export * from "./version.js";

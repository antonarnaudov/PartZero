/**
 * `@aicad/mcp-server`: the `cad` MCP server (CLI-PROVIDERS.md §6, ADR 0014).
 *
 * - {@link createMcpHost} / {@link startBroker}: the host-side tool broker (implements the gateway's
 *   `CliMcpHost`): per-run ticket, 0700 socket, scopes, FIFO, limits, stop gating, in-memory log.
 * - `aicad-mcp` (`./stdio`): the stdio shim CLI agents launch through their MCP config.
 * - {@link McpConnection} / {@link serveStreams}: the MCP protocol subset over any transport.
 * - {@link toBrokerTools} / {@link registryToolDefs} / {@link scopeToolNames}: tools generated from the
 *   agent-tools registry, per scope.
 * - `@aicad/mcp-server/host`: backends bound to a `DesignSession` (external clients, headless mode).
 */
export * from "./bridge-client.js";
export * from "./bridge-protocol.js";
export * from "./broker.js";
export * from "./jsonrpc.js";
export * from "./mcp.js";
export * from "./scopes.js";
export * from "./tools.js";
export * from "./types.js";
export * from "./version.js";

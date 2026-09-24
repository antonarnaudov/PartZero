/**
 * `@aicad/mcp-server/host`: MCP backends bound to a `DesignSession` (Node only; imports the agent tools
 * and the engines).
 *
 * - {@link sessionToolHandler}: a broker handler over one session (hosts without an orchestrator).
 * - {@link DesignHost}: the external-client host: per-client `mcp/<client>` branches, resources,
 *   scopes, rate limits, stop gating and the export directory.
 * - {@link runHeadless}: `aicad-mcp --doc <file>`.
 */
export * from "./design-host.js";
export * from "./export-dir.js";
export * from "./headless.js";
export * from "./session-handler.js";

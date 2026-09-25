/**
 * `@aicad/model-ops`: the one command layer's op catalogue (FULL-MODELING-PLAN §2.1–§2.3, contract
 * C1). One zod definition per domain op (`catalogue.ts`), applied through the Forge engine
 * (`apply.ts`), in transactions with the failure rule and ADR 0015's authorship rules
 * (`transaction.ts`, `rules.ts`). The app's command registry, the agent's tools
 * (`@aicad/agent-tools`) and the MCP server (`@aicad/mcp-server`) are generated from
 * {@link OP_CATALOGUE}.
 */
export * from "./apply.js";
export * from "./catalogue.js";
export * from "./doc.js";
export * from "./engine.js";
export * from "./expr.js";
export * from "./host.js";
export * from "./queries.js";
export * from "./rules.js";
export * from "./transaction.js";
export * from "./modeling/index.js";

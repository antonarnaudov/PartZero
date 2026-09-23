/**
 * @aicad/agent-tools — the agent's tools over a CadScript design session.
 *
 * - {@link DesignSession}: source + IR + latest report + spec tests + checkpoints, and the
 *   verification ladder (L0 compile/typecheck → L1 kernel → L2 expectations → L3 spec tests).
 * - {@link ToolRegistry}: zod-typed tools → strict JSON Schema tool definitions (sorted), input
 *   validation, errors as results.
 * - {@link designTools}: the v0 tools (get_code, apply_cadscript, ir_summary, measure,
 *   set_spec_tests, submit_spec, run_tests, checkpoint, rollback, ask_user, propose).
 * - {@link repairHint}: operation playbooks — an actionable, computed-where-possible hint for
 *   every error code.
 */
export * from "./format.js";
export * from "./playbooks.js";
export * from "./registry.js";
export * from "./session.js";
export * from "./sketch-geom.js";
export * from "./source.js";
export * from "./spec.js";
export * from "./summaries.js";
export * from "./tools.js";

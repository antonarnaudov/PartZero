/**
 * @aicad/agent-tools — the agent's tools over a CadScript design session.
 *
 * - {@link DesignSession}: source + IR + latest report + spec tests + checkpoints, and the
 *   verification ladder (L0 compile/typecheck → L1 kernel → L2 expectations → L3 spec tests).
 * - {@link ToolRegistry}: zod-typed tools → strict JSON Schema tool definitions (sorted), input
 *   validation, errors as results.
 * - {@link designTools}: the v0 tools (get_code, apply_cadscript, ir_summary, measure,
 *   set_spec_tests, submit_spec, run_tests, checkpoint, rollback, ask_user, propose).
 * - {@link opTools}: the command layer's ops (`@aicad/model-ops`) as tools — add_feature, set_field,
 *   delete_feature, add_param, … — over an `OpsHost` (the app's live document or an in-memory one):
 *   the agent operates the modeling tools instead of writing code.
 * - {@link repairHint}: operation playbooks — an actionable, computed-where-possible hint for
 *   every error code.
 * - {@link v1}: IR v1 / CadScript v1 — `aicad.metrics/1` engines, the v1 playbooks (every code of
 *   the SPEC-v1 §7.5 catalogue, computed from `details`), the v1 design session (L1 warnings, the
 *   editability probe) and its tools (set_param, accept_ref_candidate, accept_ref_proposal,
 *   sketch_edit, query, describe, …).
 */
export * from "./format.js";
export * from "./modeling.js";
export * from "./ops.js";
export * from "./playbooks.js";
export * from "./registry.js";
export * from "./session.js";
export * from "./sketch-geom.js";
export * from "./source.js";
export * from "./spec.js";
export * from "./summaries.js";
export * from "./tools.js";
/** IR v1 / CadScript v1: engines, playbooks, the v1 design session and its tools. */
export * as v1 from "./v1/index.js";

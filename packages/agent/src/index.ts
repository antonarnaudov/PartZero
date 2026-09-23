/**
 * @aicad/agent — the agent orchestrator over the model-agnostic LLM gateway.
 *
 * - {@link Agent}: TRIAGE → CLARIFY → SPEC → BUILD (L0–L3 ladder, REPAIR ×2, ROLLBACK+REPLAN ×1,
 *   stop rules) → PROPOSE, with per-task budget and a full trace.
 * - {@link LLMSolver}: the agent as a MakerBench `Solver`; {@link runBakeOff}: one MakerBench run
 *   per designer model plus a comparison table.
 * - {@link ScriptedTransport}: offline scripted models (tests, CI, dry runs).
 */
export { Agent, resultLine, type AgentHooks, type AgentOptions, type AgentRequest, type AgentResult, type AgentStatus, type JudgeVerdict } from "./agent.js";
export { comparisonRows, comparisonTable, runBakeOff, type BakeOffOptions, type ComparisonRow, type ModelRun } from "./bench.js";
export { main as cliMain, USAGE, type CliDeps, type CliIo } from "./cli-main.js";
export { AGENT_ROLES, DEFAULT_MAX_OUTPUT_TOKENS, resolveModels, SMALL_MODEL_BY_PROVIDER, type AgentModels, type AgentRole, type ModelChoice, type ModelOverrides } from "./models.js";
export { DEFAULT_PROMPT_VERSION, defaultPromptsDir, loadPrompt, type PromptInfo, type PromptRole } from "./prompts.js";
export { cadscriptReference } from "./reference.js";
export { AgentStop, DEFAULT_LIMITS, type AgentLimits } from "./run-context.js";
export { LLMSolver, type AgentRunRecord, type LLMSolverOptions } from "./solver.js";
export { runSpecWriter, type Clarification, type SpecOutcome } from "./spec-writer.js";
export { describeCall, ScriptedTransport, scriptedGateway, type ScriptedCall, type ScriptRole, type ScriptStep, type Scripts, type ScriptTurn } from "./testing.js";
export { formatTraceSummary, TraceRecorder, type AgentState, type AgentStopReason, type LlmCallRecord, type TraceEvent, type TraceSummary } from "./trace.js";
export { CLASSIFY_TOOL, classifySchema, runTriage, type Complexity, type TriageKind, type TriageResult } from "./triage.js";

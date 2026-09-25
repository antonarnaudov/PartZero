/**
 * @aicad/agent — the agent orchestrator over the model-agnostic LLM gateway.
 *
 * - {@link Agent}: TRIAGE → CLARIFY → SPEC → BUILD (L0–L3 ladder, REPAIR ×2, ROLLBACK+REPLAN ×1,
 *   stop rules) → PROPOSE, with per-task budget and a full trace. With `ops` (an `OpsHost`) it is
 *   the live operator ({@link OperatorRun}): it edits the document through the command layer's op
 *   tools, step by step, instead of writing CadScript.
 * - {@link LLMSolver}: the agent as a MakerBench `Solver`; {@link runBakeOff}: one MakerBench run
 *   per designer model plus a comparison table.
 * - {@link ScriptedTransport}: offline scripted models (tests, CI, dry runs).
 * - CLI agents as providers (ADR 0014): {@link AgentRuntime} and the mode rules here (browser-safe);
 *   the Node driver `CliAgentRuntime` is in `@aicad/agent/cli-runtime`.
 */
export { Agent, resultLine, type AgentDraft, type AgentHooks, type AgentOptions, type AgentRequest, type AgentResult, type AgentStatus, type JudgeVerdict } from "./agent.js";
export { comparisonRows, comparisonTable, runBakeOff, type BakeOffOptions, type ComparisonRow, type ModelRun } from "./bench.js";
export { main as cliMain, USAGE, type CliDeps, type CliIo } from "./cli-main.js";
export { AUTONOMY_SETTINGS, OPERATOR_WALL_MS, OperatorRun, operatorRegistry, type ApprovalRequest, type AutonomySetting, type OperatorHooks, type OperatorStep } from "./operator.js";
export { AGENT_ROLES, DEFAULT_MAX_OUTPUT_TOKENS, resolveModels, SMALL_MODEL_BY_PROVIDER, type AgentModels, type AgentRole, type ModelChoice, type ModelOverrides } from "./models.js";
export { DEFAULT_PROMPT_VERSION, defaultPromptsDir, loadPrompt, type PromptInfo, type PromptRole } from "./prompts.js";
export { cadscriptReference, cadscriptReferenceV1 } from "./reference.js";
export { AgentStop, BENCH_LIMITS, CLI_RUNTIME_MAX_FAILED_APPLIES, DEFAULT_LIMITS, throwIfCancelled, type AgentLimits } from "./run-context.js";
export { LLMSolver, type AgentRunRecord, type LLMSolverOptions } from "./solver.js";
export {
  CLI_COMPLETION_DESIGNER_WALL_MS,
  CLI_PHASE_LIMITS,
  CLI_QUESTION_WAIT_MS,
  resolvePhaseMode,
  RUNTIME_APPENDIX_V1,
  RUNTIME_APPENDIX_VERSION,
  RUNTIME_VERIFIED_PROVIDERS,
  runtimeAppendix,
  RuntimeUnsupportedError,
  type AgentRuntime,
  type CliModeOption,
  type ModePhase,
  type PhaseMode,
  type RuntimeCallControl,
  type RuntimeEndedBy,
  type RuntimePhase,
  type RuntimePhaseOutcome,
  type RuntimePhaseSpec,
  type RuntimeToolCall,
  type RuntimeToolResult,
  type RuntimeTurnRecord,
  type TurnEndDecision,
} from "./runtime.js";
export { runSpecWriter, runSpecWriterRuntime, specGateRequest, type Clarification, type SpecOutcome } from "./spec-writer.js";
export { describeCall, ScriptedTransport, scriptedGateway, type ScriptedCall, type ScriptRole, type ScriptStep, type Scripts, type ScriptTurn } from "./testing.js";
export { formatTraceSummary, TraceRecorder, type AgentState, type AgentStopReason, type LlmCallMode, type LlmCallRecord, type TraceEvent, type TraceSummary } from "./trace.js";
export { CLASSIFY_TOOL, classifySchema, runTriage, type Complexity, type TriageKind, type TriageResult } from "./triage.js";

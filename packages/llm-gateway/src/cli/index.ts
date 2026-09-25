/**
 * `@aicad/llm-gateway/cli`: CLI agents and local models as providers (ADR 0014, docs/CLI-PROVIDERS.md). Node only:
 * this entry imports `node:child_process`. Browser and server builds import the root entry, which never does.
 */
export * from "./provider.js";
export * from "./events.js";
export * from "./mcp.js";
export { CLI_ENV_BASE, CLI_ENV_DENY, CLI_ENV_LOCATION, CLI_ENV_NETWORK, cliChildEnv, secretValues, type CliEnvOptions } from "./env.js";
export {
  createCliWorkspace,
  createProbeDir,
  defaultWorkspaceRoot,
  setDefaultWorkspaceRoot,
  sweepCliWorkspaces,
  unsafeAncestor,
  WORKSPACE_MAX_AGE_MS,
  type CliWorkspace,
} from "./workspace.js";
export {
  KILL_TIMING,
  killAllCliProcesses,
  killProcessGroup,
  liveCliProcessGroups,
  OUTPUT_LIMITS,
  runCommand,
  scrubText,
  spawnCli,
  START_TIMEOUT_MS,
  stripAnsi,
  type CliProcess,
  type CommandResult,
  type SpawnSpec,
} from "./process.js";
export { commonInstallDirs, compareVersions, loginShellPath, normalizeVersion, nvmBinDirs, parseHelp, resolveBinary, versionInRange, type ResolvedBinary } from "./detect.js";
export {
  choiceCheck,
  evaluateLockdown,
  isUnofferedToolCall,
  tripwire,
  TripwireMonitor,
  type LockdownSpec,
  type LockdownViolation,
  type TripwireContext,
  type TripwireStep,
} from "./lockdown.js";
export {
  CLI_IMAGE_EXTENSIONS,
  CLI_TURN_PROTOCOL,
  cliImageFileName,
  ENVELOPE_APPENDIX_VERSION,
  envelopeAppendix,
  envelopeRepairNote,
  envelopeSchema,
  envelopeToContent,
  extractEnvelope,
  isCliImageMediaType,
  MAX_ENVELOPE_BYTES,
  MAX_ENVELOPE_CALLS,
  neutralizeAtPaths,
  PLAIN_REPLY_APPENDIX,
  renderTranscript,
  restoreAtPaths,
  submitTurnToolDef,
  type TurnEnvelope,
} from "./envelope.js";
export { CLI_FAILURE_TO_GATEWAY, cliFailureToGatewayError } from "./failure.js";
export { BaseCliProvider, binaryRefusal, cliEnvForBinary, invocationArgProblem, isNodeScript, type ExitInfo } from "./base.js";
export { ClaudeCliProvider, CLAUDE_LOGIN_FAILURE, planUsageFrom } from "./claude.js";
export { GEMINI_BUILTIN_TOOLS, GeminiCliProvider, GEMINI_P_TEXT, geminiContextFileName, geminiFailureFromText, geminiSessionId } from "./gemini.js";
export { CodexCliProvider, codexFailureFromText } from "./codex.js";
export { OPENCODE_BUILTIN_TOOLS, OpencodeProvider, OPENCODE_MESSAGE, parseMcpList, parseOpencodeModels } from "./opencode.js";
export { CursorAgentProvider, CURSOR_BLOCKED_REASON, CURSOR_MAX_PROMPT_BYTES } from "./cursor.js";
export { CLI_PROVIDERS, cliProvider } from "./registry.js";
export { CliAdapter, CLAUDE_JSON_SCHEMA_ARGV_LIMIT, type CliAdapterOptions, type CliTurnOutcome, type CliTurnPayload } from "./adapter.js";
export { CliTransport, cliGatewayParts, type CliTransportOptions } from "./transport.js";
export {
  DEFAULT_OLLAMA_URL,
  ollamaBaseUrlProblem,
  ollamaContextCheck,
  ollamaListTags,
  ollamaModelInfo,
  ollamaProfile,
  ollamaProfilesFrom,
  parseOllamaList,
  probeOllama,
  type OllamaContextCheck,
  type OllamaModelInfo,
  type OllamaStatus,
} from "./ollama.js";

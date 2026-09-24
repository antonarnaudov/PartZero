import type { Billing, CliProviderId, EnvelopeVia, ImageMediaType } from "../types.js";
import type { CliEvent, CliResultEvent } from "./events.js";
import type { McpAttachment } from "./mcp.js";
import type { CliWorkspace } from "./workspace.js";

/**
 * The CLI provider contract (docs/CLI-PROVIDERS.md §7.5, frozen). A `CliProvider` knows one CLI dialect: how to find
 * and version-gate the binary, probe its login without a model call, lock it down (every built-in tool off, only our
 * MCP server), build the exact command, and parse its JSONL output into {@link CliEvent}s.
 *
 * Additive extensions over the frozen text are marked "(additive)".
 */

export type { EnvelopeVia } from "../types.js";
export type CliAgentId = "claude" | "gemini" | "codex" | "opencode" | "cursor";
export type CliMode = "completion" | "runtime";

export interface CliCapabilities {
  modes: readonly CliMode[];
  envelopeVia: EnvelopeVia;
  promptVia: "stdin" | "argv";
  systemPromptVia: "file-flag" | "env-file" | "config-key" | "agent-config" | "workspace-rules";
  mcpConfigVia: "flag-file" | "workspace-settings" | "config-overrides" | "env-json" | "workspace-file";
  multiTurn: "stdin-stream" | "resume" | "none";
  images: "stream-json" | "file-flag" | "at-path" | "none";
  toolListInInit: boolean;
  reportsTokens: boolean;
  reportsCostUsd: boolean;
  reportsPlanUsage: boolean;
  maxTurnsControl: "flag" | "setting" | "none";
  maxToolCallMs: number;
  sessionCleanup: "none-needed" | "delete-command" | "left-behind";
}

export interface CliHelpInfo {
  flags: ReadonlySet<string>;
  subcommands: ReadonlySet<string>;
  sha256: string;
  /** (additive) `--flag` -> the values listed in its `(choices: ...)`. */
  choices?: ReadonlyMap<string, readonly string[]>;
}

export interface CliBinary {
  provider: CliProviderId;
  path: string;
  realPath: string;
  source: "settings" | "path" | "known-dir" | "login-shell";
  /** Normalized (`2.1.260`). */
  version: string;
  rawVersion: string;
  help: CliHelpInfo;
  stat: { size: number; mtimeMs: number };
}

export interface CliDetection {
  provider: CliProviderId;
  status: "not_installed" | "unsupported_version" | "blocked" | "ready";
  binary: CliBinary | null;
  lockdown: LockdownReport | null;
  detail: string;
}

export interface CliAuthStatus {
  state: "logged_in" | "logged_out" | "unknown";
  /** Label only: "claude.ai", "oauth-personal", "chatgpt", "api-key", ... */
  method: string | null;
  /** e.g. "max". NEVER email, org, account or user ids. */
  plan: string | null;
  billing: Billing;
  probe: "command" | "settings-field" | "file-presence" | "none";
  detail: string;
  checkedAt: string;
}

export interface LockdownCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface LockdownReport {
  ok: boolean;
  level: "verified" | "static" | "none";
  checks: LockdownCheck[];
  residualRisks: string[];
}

export interface CliLimits {
  maxTurns: number;
  wallMs: number;
  stallMs: number;
  maxBudgetUsd?: number;
}

/** Completion-mode defaults (§3.1). A completion-mode designer turn should pass `wallMs: 300_000`. */
export const CLI_COMPLETION_LIMITS: Readonly<CliLimits> = { maxTurns: 3, wallMs: 180_000, stallMs: 120_000 };

/** Base64 image data. */
export interface CliImage {
  mediaType: ImageMediaType;
  data: string;
}

export interface CliInvocation {
  /** uuid v4 (also the CLI session id where one is accepted). */
  runId: string;
  mode: CliMode;
  binary: CliBinary;
  workspace: CliWorkspace;
  model: string | null;
  effort: string | null;
  systemPrompt: string;
  prompt: string;
  images: readonly CliImage[];
  structured: { via: EnvelopeVia; schema: Record<string, unknown> } | null;
  mcp: McpAttachment | null;
  resume: { sessionId: string } | null;
  limits: CliLimits;
  /** `cliChildEnv()` output (includes AICAD_MCP_TICKET when `mcp` is set). */
  env: Readonly<Record<string, string>>;
}

export interface CliCommand {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: { kind: "ignore" } | { kind: "text"; text: string } | { kind: "stream-json"; first: string };
  /** Relative to `workspace.dir`. (additive) `encoding: "base64"` writes decoded bytes (images). */
  files: ReadonlyArray<{ path: string; content: string; mode: 0o400 | 0o600; encoding?: "utf8" | "base64" }>;
  /** (additive) Notes `run()` emits as `warning` events before the CLI starts (e.g. an optional flag this binary does not list). */
  warnings?: readonly string[];
}

export interface ParseContext {
  mode: CliMode;
  /** Qualified tool names the model may call. */
  allowed: ReadonlySet<string>;
  serverName: "cad";
}

export interface CliUserMessage {
  text: string;
  images?: readonly CliImage[];
}

export interface CliRunIO {
  signal?: AbortSignal;
  onStderrLine?(line: string): void;
  /** (additive) Every raw stdout JSONL line, before parsing (fixture recording, debugging). Untrusted data. */
  onStdoutLine?(line: string): void;
  now?(): number;
}

export interface CliRun {
  readonly pid: number | null;
  readonly events: AsyncIterable<CliEvent>;
  /** Throws unless `capabilities.multiTurn === "stdin-stream"`. */
  send(message: CliUserMessage): void;
  closeInput(): void;
  readonly done: Promise<CliExit>;
  /** (additive) Extend the wall clock, e.g. by the time an MCP handler waited for the user. */
  extendWall?(ms: number): void;
  /**
   * (additive) The broker handler reports a CAD tool call in progress (`true` at start, `false` at the end, nestable).
   * The stall timer is paused while any is open (§5.8) and restarts when the last one ends. Needed because some CLIs
   * report a tool call only once it finished (opencode), so the event stream alone cannot pause the timer.
   */
  brokerBusy?(on: boolean): void;
}

export interface CliExit {
  code: number | null;
  signal: string | null;
  reason: "exited" | "timeout" | "stalled" | "cancelled" | "killed" | "spawn_failed";
  result: CliResultEvent | null;
  stderrTail: string;
  failure: CliFailure | null;
}

export type CliFailureCode =
  | "not_installed"
  | "unsupported"
  | "lockdown_violation"
  | "not_logged_in"
  | "rate_limited"
  | "quota_exhausted"
  | "context_overflow"
  | "max_turns"
  | "budget"
  | "timeout"
  | "stalled"
  | "cancelled"
  | "bad_output"
  | "crashed"
  | "unknown";

export interface CliFailure {
  code: CliFailureCode;
  message: string;
  retryAfterMs?: number;
  resetsAt?: string;
}

export interface DetectOptions {
  /** Settings -> CLI path. */
  overridePath: string | null;
  env: Readonly<Record<string, string>>;
  /** Known install dirs (per provider + common). */
  extraDirs: readonly string[];
  /** Last resort: `$SHELL -ilc 'command -v <name>'`, 5 s, once per session. */
  loginShell: boolean;
}

export interface DiscoveredModel {
  modelArg: string;
  displayName: string;
  vendor: string;
  family: string;
  tools: boolean;
  vision: boolean;
  contextWindow: number | null;
  billing: Billing;
}

export interface CliProvider {
  readonly id: CliProviderId;
  readonly agent: CliAgentId;
  /** "Claude Code". */
  readonly label: string;
  readonly binaryNames: readonly string[];
  readonly minVersion: string;
  readonly verifiedRange: { from: string; to: string } | null;
  readonly capabilities: CliCapabilities;
  /** Shown verbatim: "Run `claude auth login` in a terminal". */
  readonly loginHint: string;

  /** Locate the binary, read --version and --help, evaluate lockdown. No model call. */
  detect(options: DetectOptions): Promise<CliDetection>;
  /** `<bin> --version`, normalized. 10 s timeout. */
  version(path: string, env: Readonly<Record<string, string>>): Promise<string>;
  /** Cheap login probe (§4). Never reads credential files or keychain entries. No model call. */
  authStatus(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<CliAuthStatus>;
  /** Pure: can this binary enforce our lockdown? */
  lockdown(binary: CliBinary): LockdownReport;
  /** Bare tool name -> the name the model and the event stream use. */
  qualifiedToolName(tool: string): string;
  /** Pure: the exact command, files and stdin for an invocation. */
  buildArgs(inv: CliInvocation): CliCommand;
  /** Pure: CLI-native JSONL lines -> normalized events (dialect knowledge lives here only). */
  parseEvents(lines: AsyncIterable<string>, ctx: ParseContext): AsyncIterable<CliEvent>;
  /** Spawn per §5.8 (materialize files, apply tripwires, enforce timers) and stream normalized events. */
  run(inv: CliInvocation, io?: CliRunIO): CliRun;
  /** Graceful -> forceful termination of the whole process group. Idempotent. */
  cancel(run: CliRun, reason: "user" | "timeout" | "stalled" | "stop" | "lockdown"): Promise<CliExit>;
  /** Delete the CLI-side session after the phase (Gemini, Codex runtime, opencode). */
  cleanup?(inv: CliInvocation, sessionId: string | null): Promise<void>;
  /** Optional model discovery (Codex `debug models`, opencode `models --verbose`, Cursor `models`). */
  listModels?(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<DiscoveredModel[]>;
}

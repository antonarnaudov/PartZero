/**
 * The host-side MCP contract, frozen in CLI-PROVIDERS.md §7.6 (`@aicad/llm-gateway/cli`, `src/cli/mcp.ts`).
 *
 * The gateway owns these declarations so that it never depends on this package. Until the gateway's
 * `src/cli/mcp.ts` lands (wave 1), they are mirrored here **structurally identical**; TypeScript's
 * structural typing makes {@link createMcpHost}'s result assignable to the gateway's `CliMcpHost`.
 * When the gateway ships them, replace this file's bodies with `export type { … } from "@aicad/llm-gateway/cli"`.
 *
 * Additive extensions, not yet in the gateway's frozen §7.6 (for its §16 change log). All optional, so
 * `createMcpHost()` stays assignable to the gateway's `CliMcpHost` (test/gateway-contract.test.ts):
 * - `open({ orchTag })`: the run's orchestrator tag, put in place of `<orch>` in every text the broker
 *   writes (closed, call limit, handler timeout). Without it the placeholder is dropped.
 * - `open({ mayWaitForUser })`: any call's handler may wait for the user (the 80 % budget checkpoint in
 *   interactive runs), not only `ask_user`'s; raises `callTimeoutMs` and every call's user-wait allowance.
 * - `handler(call, control)`: {@link McpCallControl.userWait} pauses the handler deadline while the user answers.
 */
import type { ToolDef } from "@aicad/llm-gateway";

export type McpScope = "spec" | "design" | "read" | "submit" | "ext-read" | "ext-edit" | "ext-export";

export const MCP_SCOPES: readonly McpScope[] = ["spec", "design", "read", "submit", "ext-read", "ext-edit", "ext-export"];

export interface McpToolCall {
  seq: number;
  name: string;
  args: Record<string, unknown>;
  toolUseId: string | null;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
  /** Close the broker after delivering this result (stop, proposal accepted, spec submitted). */
  close?: string;
  /** Time the handler spent waiting for the user (extends the wall clock). */
  userWaitMs?: number;
}

/** What the broker hands a handler with each call (additive second argument). */
export interface McpCallControl {
  /**
   * Wrap a wait for the user (a question, the budget checkpoint): the handler deadline is paused until
   * `wait` settles. Waits count up to `MAX_USER_WAIT_PER_CALL_MS` per call; beyond that the deadline runs.
   * Returns `wait`'s outcome unchanged.
   */
  userWait<T>(wait: Promise<T>): Promise<T>;
}

export interface BrokerLimits {
  /** Runtime default 240; submit 4. */
  maxCalls: number;
  /** 262_144. */
  maxArgBytes: number;
  /** 3 (for CLIs that restart the server), one active at a time. */
  maxConnections: number;
  /** 5_000: after close(), connections are ended once this grace has passed. */
  closeGraceMs: number;
  /** 2. */
  maxCallsAfterClose: number;
  /** 120_000, excluding user waits (the question wait is capped at 600 s). */
  handlerTimeoutMs: number;
}

export interface McpAttachment {
  serverName: "cad";
  command: string;
  args: readonly string[];
  /** Non-secret: AICAD_MCP_BRIDGE, ELECTRON_RUN_AS_NODE. Never the ticket. */
  env: Readonly<Record<string, string>>;
  /** Name of the env var the CLI must carry (value in {@link CliMcpSession.ticket}). */
  ticketEnv: "AICAD_MCP_TICKET";
  /** Bare tool names in scope. */
  toolNames: readonly string[];
  callTimeoutMs: number;
}

export interface CliMcpSession {
  readonly attachment: McpAttachment;
  /** Goes only into the CLI's environment. */
  readonly ticket: string;
  readonly state: "open" | "closing" | "closed";
  close(reason: string): void;
  dispose(): Promise<void>;
  log(): ReadonlyArray<{ seq: number; name: string; isError: boolean; ms: number; text: string }>;
}

/**
 * A gateway tool definition as the runtime passes it. Build it with `registryToolDefs()`, which sets
 * `readOnly` from the registry (`ToolRegistry.defs()` leaves it out). `createMcpHost().open()` fills a
 * missing `readOnly` from `READ_ONLY_TOOLS` and refuses a `read`/`ext-read` scope with a writing tool.
 */
export type McpToolDef = ToolDef & { readOnly?: boolean };

export interface McpOpenRequest {
  dir: string;
  scope: McpScope;
  tools: readonly McpToolDef[];
  instructions: string;
  handler(call: McpToolCall, control: McpCallControl): Promise<McpToolResult>;
  limits?: Partial<BrokerLimits>;
  onClose?(reason: string): void;
  onViolation?(v: { kind: string; detail: string }): void;
  /** Additive: the run's orchestrator tag (`[orchestrator <nonce>]`), put in place of `<orch>` in the broker's own texts. */
  orchTag?: string;
  /** Additive: any call may wait for the user (interactive budget checkpoint), not only `ask_user`. */
  mayWaitForUser?: boolean;
}

export interface CliMcpHost {
  open(request: McpOpenRequest): Promise<CliMcpSession>;
}

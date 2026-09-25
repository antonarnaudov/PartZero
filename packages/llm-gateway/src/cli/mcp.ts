import type { ToolDef } from "../types.js";

/**
 * The contract between CLI providers and our MCP server (docs/CLI-PROVIDERS.md §6 and §7.6, frozen).
 * `@aicad/mcp-server` implements {@link CliMcpHost}; the gateway only declares it, so it has no dependency on the MCP
 * package. Every broker instance serves exactly one phase (or one completion call) of one run.
 */

/**
 * `ops`, `ext-ops`, `ops-read` (additive, FULL-MODELING-PLAN §2.1): the command layer's op tools over the live
 * document (`@aicad/mcp-server` `ops.ts`).
 */
export type McpScope = "spec" | "design" | "read" | "submit" | "ext-read" | "ext-edit" | "ext-export" | "ops" | "ext-ops" | "ops-read";

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

export interface McpAttachment {
  serverName: "cad";
  command: string;
  args: readonly string[];
  /** Non-secret: AICAD_MCP_BRIDGE, ELECTRON_RUN_AS_NODE. Never the ticket. */
  env: Readonly<Record<string, string>>;
  /** Name of the env var the CLI must carry (value in {@link CliMcpSession.ticket}). */
  ticketEnv: "AICAD_MCP_TICKET";
  /** Bare names in scope. */
  toolNames: readonly string[];
  callTimeoutMs: number;
}

export interface CliMcpSession {
  readonly attachment: McpAttachment;
  /** Goes only into the CLI's environment. Never logged, never in argv, never on disk. */
  readonly ticket: string;
  readonly state: "open" | "closing" | "closed";
  close(reason: string): void;
  dispose(): Promise<void>;
  log(): ReadonlyArray<{ seq: number; name: string; isError: boolean; ms: number; text: string }>;
}

export interface BrokerLimits {
  /** Runtime default 240; submit 4. */
  maxCalls: number;
  maxArgBytes: number;
  maxConnections: number;
  closeGraceMs: number;
  maxCallsAfterClose: number;
  /** Excluding the handler's reported `userWaitMs`. */
  handlerTimeoutMs: number;
}

export const DEFAULT_BROKER_LIMITS: Readonly<BrokerLimits> = {
  maxCalls: 240,
  maxArgBytes: 262_144,
  maxConnections: 3,
  closeGraceMs: 5_000,
  maxCallsAfterClose: 2,
  handlerTimeoutMs: 120_000,
};

/** Broker limits for the `submit` scope (completion mode, `mcp-submit` envelope channel). */
export const SUBMIT_BROKER_LIMITS: Partial<BrokerLimits> = { maxCalls: 4 };

export interface CliMcpHost {
  open(request: {
    dir: string;
    scope: McpScope;
    tools: readonly ToolDef[];
    instructions: string;
    handler(call: McpToolCall): Promise<McpToolResult>;
    limits?: Partial<BrokerLimits>;
    onClose?(reason: string): void;
    onViolation?(v: { kind: string; detail: string }): void;
  }): Promise<CliMcpSession>;
}

/** What every call after a broker close is answered with (§3.3). `<orch>` is replaced by the run's tag by the host. */
export function BROKER_CLOSED_TEXT(reason: string): string {
  return `<orch> The task has ended (${reason}). Do not call any more tools; reply with one short line.`;
}

/** Name of the envelope tool in the `submit` scope. */
export const SUBMIT_TURN_TOOL = "submit_turn";
/** Answer to a valid `submit_turn` call. */
export const SUBMIT_TURN_OK_TEXT = "Recorded. End your turn now.";

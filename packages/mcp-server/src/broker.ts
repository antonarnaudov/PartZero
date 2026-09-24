/**
 * The host-side tool broker (FROZEN: CLI-PROVIDERS.md §6.5) and `createMcpHost()`, which implements
 * the gateway's `CliMcpHost` (§7.6).
 *
 * One broker serves exactly one phase of one run. It listens on a Unix socket in a 0700 directory
 * (Windows: a named pipe), authenticates the shim with a per-run ticket (`timingSafeEqual`), and runs
 * the calls it forwards through the host's handler:
 *
 * 1. FIFO, one call at a time (`DesignSession` is not re-entrant; some CLIs issue parallel calls). At
 *    most {@link MAX_QUEUED_CALLS} calls wait per connection; more are refused at once (`queue_full`).
 * 2. Before the handler runs: state, argument size, tool in scope, `maxCalls`. A violation answers
 *    `isError` with a one-line reason and calls `onViolation`; `call_limit` also closes the broker.
 *    Refused calls (unknown tool, argument size, queue full) count toward `maxCalls` too, so a model
 *    looping on refusals ends at the call limit.
 * 3. After `close()`: every call gets the closed text (`BROKER_CLOSED_TEXT(reason)` with the run's
 *    orchestrator tag). The `maxCallsAfterClose`-th call that **arrived** after close reports
 *    `after_close_limit` (the driver kills the process); calls already queued at close are answered but
 *    not counted. Connections end after `closeGraceMs`.
 * 4. Handler results pass through unchanged, except that the text is clipped at 16 KiB. A result with
 *    `close` set closes the broker **after** it is delivered. `<orch>` is substituted only in texts the
 *    broker writes itself, never in handler results (they can echo model-written text).
 * 5. Handler deadline: `handlerTimeoutMs`, excluding user waits. A handler reports a wait through
 *    `control.userWait(promise)` (the deadline pauses); `ask_user`, and every tool when the host set
 *    `mayWaitForUser`, also get a static allowance of `CLI_QUESTION_WAIT_MS` for handlers that do not.
 * 6. Logging is in memory only: `{seq, name, argBytes, isError, ms}` plus each result's text (for the
 *    transcript). Arguments and results never reach the disk; the ticket is never logged.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_ENDPOINT_ENV,
  BRIDGE_PROTOCOL,
  BRIDGE_TICKET_ENV,
  closedText,
  encodeFrame,
  isOrchTag,
  MAX_BRIDGE_FRAME_BYTES,
  parseClientMsg,
  type BridgeHostMsg,
  type BrokerTool,
} from "./bridge-protocol.js";
import { LineSplitter } from "./jsonrpc.js";
import { CLI_QUESTION_WAIT_MS, MAX_USER_WAIT_PER_CALL_MS, READ_SCOPES, USER_WAIT_TOOLS, withReadOnly } from "./scopes.js";
import { toBrokerTools } from "./tools.js";
import type { BrokerLimits, CliMcpHost, CliMcpSession, McpAttachment, McpCallControl, McpOpenRequest, McpScope, McpToolCall, McpToolResult } from "./types.js";
import { MCP_SERVER_VERSION } from "./version.js";

export type { BrokerLimits } from "./types.js";

export const DEFAULT_BROKER_LIMITS: Readonly<BrokerLimits> = Object.freeze({
  maxCalls: 240,
  maxArgBytes: 262_144,
  maxConnections: 3,
  closeGraceMs: 5_000,
  maxCallsAfterClose: 2,
  handlerTimeoutMs: 120_000,
});

/** Limits for the `submit` scope (completion mode, `mcp-submit`): 4 calls. */
export const SUBMIT_BROKER_LIMITS: Readonly<Partial<BrokerLimits>> = Object.freeze({ maxCalls: 4 });

/** Backstop clip for handler result text (the registry already clips to ~2k tokens). */
export const MAX_RESULT_CHARS = 16 * 1024;

/** A connection must authenticate within this time. */
export const HELLO_TIMEOUT_MS = 5_000;

/** MCP call timeout a CLI must allow when `ask_user` is in scope (Claude `MCP_TOOL_TIMEOUT=900000`). */
export const MCP_CALL_TIMEOUT_WITH_USER_MS = 900_000;

/** Unauthenticated sockets allowed at once (each is bounded by {@link HELLO_TIMEOUT_MS}). */
const MAX_PENDING_SOCKETS = 8;

/** Calls one connection may have waiting behind the running one; more are refused (`queue_full`). */
export const MAX_QUEUED_CALLS = 16;

/** macOS `sun_path` holds 104 bytes including the terminator. */
const MAX_SOCKET_PATH_BYTES = 103;

/**
 * The frozen kinds (§6.5) plus `queue_full` (additive: a call arrived while {@link MAX_QUEUED_CALLS}
 * were already waiting). The gateway's `onViolation` takes any string.
 */
export type BrokerViolationKind = "call_limit" | "arg_size" | "unknown_tool" | "after_close_limit" | "handler_timeout" | "queue_full";

export interface BrokerOptions {
  /** `workspace.socketDir`: created 0700 when missing; an existing directory must be 0700 and ours. */
  dir: string;
  scope: McpScope;
  tools: readonly BrokerTool[];
  instructions: string;
  /** `control` (additive) lets the handler exclude user waits from its deadline. */
  handler(call: McpToolCall, control: McpCallControl): Promise<McpToolResult>;
  limits?: Partial<BrokerLimits>;
  /** The driver starts `closeGraceMs`, then kills. */
  onClose?(reason: string): void;
  onViolation?(v: { kind: BrokerViolationKind; detail: string }): void;
  /** Additive: the run's orchestrator tag; replaces `<orch>` in the texts the broker writes (dropped when absent). */
  orchTag?: string;
  /** Additive: any call's handler may wait for the user; every call gets the static user-wait allowance. */
  mayWaitForUser?: boolean;
}

export interface ToolBroker {
  /** Socket path or pipe name. */
  readonly endpoint: string;
  /** 32 random bytes, hex; never logged. */
  readonly ticket: string;
  readonly state: "open" | "closing" | "closed";
  close(reason: string): void;
  /** Closes the listener, unlinks the socket. */
  dispose(): Promise<void>;
  stats(): { calls: number; refused: number; connections: number; lastCallAt: number | null };
}

export interface BrokerLogEntry {
  seq: number;
  name: string;
  argBytes: number;
  isError: boolean;
  ms: number;
  /** The text the model received. In memory only. */
  text: string;
  /** Answered without running the handler (closed, refused, cancelled). */
  refused: boolean;
}

/** The broker as {@link startBroker} returns it: the frozen interface plus its in-memory log. */
export interface LoggingToolBroker extends ToolBroker {
  log(): readonly BrokerLogEntry[];
  /** The MCP `clientInfo` of the last authenticated connection (null before one, or when the client sent none). */
  readonly client: { name: string; version: string } | null;
}

export interface McpShimCommand {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

interface Conn {
  socket: Socket;
  authed: boolean;
  closed: boolean;
}

interface QueuedCall {
  conn: Conn;
  id: number;
  name: string;
  args: Record<string, unknown>;
  toolUseId: string | null;
  argBytes: number;
  /** The broker was open when the call arrived (calls already queued at close are not after-close calls). */
  arrivedOpen: boolean;
}

function clipText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  let cut = MAX_RESULT_CHARS - 40;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // never split a surrogate pair
  return `${text.slice(0, cut)}\n… [clipped at ${MAX_RESULT_CHARS} chars]`;
}

function sameTicket(expected: Buffer, given: string): boolean {
  const g = Buffer.from(given, "utf8");
  if (g.length !== expected.length) {
    timingSafeEqual(expected, expected); // keep the timing independent of the length check
    return false;
  }
  return timingSafeEqual(expected, g);
}

async function prepareEndpoint(dir: string): Promise<string> {
  if (process.platform === "win32") return `\\\\.\\pipe\\aicad-mcp-${randomBytes(8).toString("hex")}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory()) throw new Error("broker socket dir is not a directory");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error("broker socket dir is not owned by this user");
  if ((st.mode & 0o077) !== 0) throw new Error("broker socket dir must be private (mode 0700)");
  const endpoint = join(dir, "b.sock");
  if (Buffer.byteLength(endpoint, "utf8") > MAX_SOCKET_PATH_BYTES) throw new Error(`broker socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes; use a shorter socket dir`);
  const existing = await lstat(endpoint).catch(() => null);
  if (existing) throw new Error("broker socket path already exists");
  return endpoint;
}

class Broker implements LoggingToolBroker {
  readonly endpoint: string;
  readonly ticket: string;
  readonly #ticketBuf: Buffer;
  readonly #o: BrokerOptions;
  readonly #limits: BrokerLimits;
  readonly #toolNames: ReadonlySet<string>;
  readonly #server: Server;
  readonly #conns = new Set<Conn>();
  readonly #queue: QueuedCall[] = [];
  readonly #log: BrokerLogEntry[] = [];
  #state: "open" | "closing" | "closed" = "open";
  #closeReason = "";
  #graceTimer: NodeJS.Timeout | undefined;
  #active: Conn | null = null;
  #accepted = 0;
  #calls = 0;
  #refused = 0;
  /** Calls refused while open (unknown tool, argument size, queue full): they count toward `maxCalls`. */
  #refusedOpen = 0;
  #afterClose = 0;
  #afterCloseReported = false;
  #lastCallAt: number | null = null;
  #seq = 0;
  #pumping = false;
  #disposed: Promise<void> | null = null;
  #client: { name: string; version: string } | null = null;

  constructor(endpoint: string, server: Server, options: BrokerOptions) {
    this.endpoint = endpoint;
    this.ticket = randomBytes(32).toString("hex");
    this.#ticketBuf = Buffer.from(this.ticket, "utf8");
    this.#o = options;
    this.#limits = { ...DEFAULT_BROKER_LIMITS, ...options.limits };
    this.#toolNames = new Set(options.tools.map((t) => t.name));
    this.#server = server;
    server.on("connection", (socket) => this.#accept(socket));
  }

  get state(): "open" | "closing" | "closed" {
    return this.#state;
  }

  stats(): { calls: number; refused: number; connections: number; lastCallAt: number | null } {
    return { calls: this.#calls, refused: this.#refused, connections: this.#accepted, lastCallAt: this.#lastCallAt };
  }

  log(): readonly BrokerLogEntry[] {
    return this.#log;
  }

  get client(): { name: string; version: string } | null {
    return this.#client;
  }

  close(reason: string): void {
    if (this.#state !== "open") return;
    this.#state = "closing";
    this.#closeReason = reason;
    if (this.#active) this.#send(this.#active, this.#closedFrame());
    this.#graceTimer = setTimeout(() => this.#finishClose(), this.#limits.closeGraceMs);
    this.#graceTimer.unref();
    try {
      this.#o.onClose?.(reason);
    } catch {
      // a host callback must not break the broker
    }
  }

  dispose(): Promise<void> {
    if (this.#disposed) return this.#disposed;
    if (this.#state === "open") this.#closeReason ||= "disposed";
    this.#finishClose();
    this.#disposed = (async () => {
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
      if (process.platform !== "win32") await unlink(this.endpoint).catch(() => undefined);
    })();
    return this.#disposed;
  }

  #finishClose(): void {
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    this.#graceTimer = undefined;
    this.#state = "closed";
    this.#queue.length = 0;
    for (const c of this.#conns) this.#end(c);
    // Stop accepting; the socket file is unlinked by dispose().
    this.#server.close();
  }

  #violation(kind: BrokerViolationKind, detail: string): void {
    try {
      this.#o.onViolation?.({ kind, detail });
    } catch {
      // ignore host callback failures
    }
  }

  /** The closed text with the run's orchestrator tag (texts the broker writes; never handler results). */
  #closedText(reason: string): string {
    return closedText(reason, this.#o.orchTag);
  }

  #closedFrame(): BridgeHostMsg {
    return { t: "closed", reason: this.#closeReason, text: this.#closedText(this.#closeReason) };
  }

  // ── Connections ──

  #accept(socket: Socket): void {
    let unauthenticated = 0;
    for (const c of this.#conns) if (!c.authed) unauthenticated++;
    if (this.#state === "closed" || unauthenticated >= MAX_PENDING_SOCKETS) {
      socket.destroy();
      return;
    }
    const conn: Conn = { socket, authed: false, closed: false };
    this.#conns.add(conn);
    socket.setNoDelay(true);
    const helloTimer = setTimeout(() => this.#deny(conn, "protocol"), HELLO_TIMEOUT_MS);
    helloTimer.unref();
    const splitter = new LineSplitter(
      (line) => this.#frame(conn, line, helloTimer),
      () => this.#deny(conn, "protocol"),
      MAX_BRIDGE_FRAME_BYTES,
    );
    socket.on("data", (chunk: Buffer) => {
      if (!conn.closed) splitter.push(chunk);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(helloTimer);
      conn.closed = true;
      this.#conns.delete(conn);
      if (this.#active === conn) this.#active = null;
      // Calls that have not started are dropped: nobody can receive their results.
      for (let i = this.#queue.length - 1; i >= 0; i--) if (this.#queue[i]!.conn === conn) this.#queue.splice(i, 1);
    });
  }

  #end(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    conn.socket.destroySoon();
  }

  #deny(conn: Conn, reason: "bad_ticket" | "too_many_connections" | "protocol" | "closed"): void {
    if (conn.closed) return;
    this.#send(conn, { t: "denied", reason });
    this.#end(conn);
  }

  #send(conn: Conn, msg: BridgeHostMsg): void {
    if (conn.closed || conn.socket.destroyed || !conn.socket.writable) return;
    conn.socket.write(encodeFrame(msg));
  }

  #frame(conn: Conn, line: string, helloTimer: NodeJS.Timeout): void {
    if (conn.closed) return;
    const p = parseClientMsg(line);
    if (!p.ok) {
      this.#deny(conn, "protocol");
      return;
    }
    const msg = p.msg;
    if (!conn.authed) {
      clearTimeout(helloTimer);
      if (msg.t !== "hello") return this.#deny(conn, "protocol");
      if (!sameTicket(this.#ticketBuf, msg.ticket)) return this.#deny(conn, "bad_ticket");
      if (this.#state === "closed") return this.#deny(conn, "closed");
      if (this.#accepted >= this.#limits.maxConnections || (this.#active && !this.#active.closed)) return this.#deny(conn, "too_many_connections");
      conn.authed = true;
      this.#accepted++;
      this.#client = msg.client;
      this.#active = conn;
      this.#send(conn, {
        t: "welcome",
        v: BRIDGE_PROTOCOL,
        scope: this.#o.scope,
        server: { name: "cad", version: MCP_SERVER_VERSION },
        instructions: this.#o.instructions,
        tools: [...this.#o.tools],
      });
      if (this.#state === "closing") this.#send(conn, this.#closedFrame());
      return;
    }
    switch (msg.t) {
      case "hello":
        return this.#deny(conn, "protocol");
      case "bye":
        return this.#end(conn);
      case "cancel": {
        const i = this.#queue.findIndex((q) => q.conn === conn && q.id === msg.id);
        if (i >= 0) {
          const [q] = this.#queue.splice(i, 1);
          this.#answer(q!, { text: "Cancelled by the client before it ran.", isError: true }, 0, true);
        }
        return; // a running call is not interrupted (advisory)
      }
      case "call": {
        const argBytes = Buffer.byteLength(JSON.stringify(msg.args), "utf8");
        const q: QueuedCall = { conn, id: msg.id, name: msg.name, args: msg.args, toolUseId: msg.toolUseId, argBytes, arrivedOpen: this.#state === "open" };
        // After close nothing runs any more: answer at once instead of queueing behind a running handler.
        if (!q.arrivedOpen) return this.#answerClosed(q);
        if (this.#callLimitReached()) return this.#hitCallLimit(q);
        let waiting = 0;
        for (const x of this.#queue) if (x.conn === conn) waiting++;
        if (waiting >= MAX_QUEUED_CALLS) {
          return this.#refuse(q, `Not executed: ${MAX_QUEUED_CALLS} calls are already waiting. Wait for their results before calling again.`, "queue_full", `${q.name}: ${waiting} calls waiting`);
        }
        this.#queue.push(q);
        void this.#pump();
        return;
      }
    }
  }

  // ── Calls ──

  #answer(q: QueuedCall, out: { text: string; isError: boolean }, ms: number, refused: boolean, seq = ++this.#seq): number {
    const text = clipText(out.text);
    this.#log.push({ seq, name: q.name, argBytes: q.argBytes, isError: out.isError, ms, text, refused });
    if (refused) this.#refused++;
    this.#send(q.conn, { t: "result", id: q.id, text, isError: out.isError });
    return seq;
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length > 0) {
        const q = this.#queue.shift()!;
        if (q.conn.closed) continue;
        await this.#process(q);
      }
    } finally {
      this.#pumping = false;
    }
  }

  /** Answer a call with the closed text; count it only when it arrived after close (the model saw the text). */
  #answerClosed(q: QueuedCall): void {
    this.#answer(q, { text: this.#closedText(this.#closeReason), isError: true }, 0, true);
    if (q.arrivedOpen) return;
    this.#afterClose++;
    if (this.#afterClose >= this.#limits.maxCallsAfterClose && !this.#afterCloseReported) {
      this.#afterCloseReported = true;
      this.#violation("after_close_limit", `${this.#afterClose} calls after close (${this.#closeReason})`);
    }
  }

  /** Refuse a call before the handler (one-line reason), report it, and count it toward `maxCalls`. */
  #refuse(q: QueuedCall, text: string, kind: BrokerViolationKind, detail: string): void {
    this.#answer(q, { text, isError: true }, 0, true);
    this.#violation(kind, detail);
    if (this.#state === "open") this.#refusedOpen++;
  }

  #callLimitReached(): boolean {
    return this.#calls + this.#refusedOpen >= this.#limits.maxCalls;
  }

  #hitCallLimit(q: QueuedCall): void {
    this.#violation("call_limit", `${this.#calls} calls, ${this.#refusedOpen} refused`);
    this.close("call_limit");
    this.#answer(q, { text: this.#closedText("call_limit"), isError: true }, 0, true);
  }

  async #process(q: QueuedCall): Promise<void> {
    const L = this.#limits;
    // 1. State.
    if (this.#state !== "open") return this.#answerClosed(q);
    // 2. Call limit (handler runs plus refusals).
    if (this.#callLimitReached()) return this.#hitCallLimit(q);
    // 3. Argument size.
    if (q.argBytes > L.maxArgBytes) {
      return this.#refuse(q, `Not executed: the arguments are ${q.argBytes} bytes; the limit is ${L.maxArgBytes}. Send smaller edits (patches).`, "arg_size", `${q.name}: ${q.argBytes} bytes`);
    }
    // 4. In scope.
    if (!this.#toolNames.has(q.name)) return this.#refuse(q, `Unknown tool "${q.name}". Available: ${[...this.#toolNames].join(", ")}.`, "unknown_tool", q.name);
    this.#calls++;
    const started = Date.now();
    this.#lastCallAt = started;
    const seq = ++this.#seq;
    const call: McpToolCall = { seq, name: q.name, args: q.args, toolUseId: q.toolUseId };

    // Deadline: handlerTimeoutMs of handler time. User waits reported through control.userWait() are
    // excluded (up to MAX_USER_WAIT_PER_CALL_MS); ask_user, or every tool with mayWaitForUser, also gets
    // a static CLI_QUESTION_WAIT_MS for handlers that do not report their waits.
    const allowance = this.#o.mayWaitForUser === true || USER_WAIT_TOOLS.has(q.name) ? CLI_QUESTION_WAIT_MS : 0;
    let settled = false;
    let waits = 0;
    let waitStart = 0;
    let waited = 0;
    const credit = (): number => Math.min(MAX_USER_WAIT_PER_CALL_MS, waited + (waits > 0 ? Date.now() - waitStart : 0));
    const remaining = (): number => L.handlerTimeoutMs + Math.max(allowance, credit()) - (Date.now() - started);
    const control: McpCallControl = {
      userWait<T>(wait: Promise<T>): Promise<T> {
        if (settled) return wait;
        if (waits++ === 0) waitStart = Date.now();
        return Promise.resolve(wait).finally(() => {
          if (--waits === 0) waited += Date.now() - waitStart;
        });
      },
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      // Re-checked when it fires: a user wait may have moved the deadline.
      const arm = (): void => {
        const ms = remaining();
        if (ms <= 0) return resolve("timeout");
        timer = setTimeout(arm, ms);
        timer.unref();
      };
      arm();
    });
    let result: McpToolResult | "timeout";
    try {
      result = await Promise.race([this.#o.handler(call, control), timeout]);
    } catch {
      result = { text: `${q.name} failed in the CAD host.`, isError: true };
    } finally {
      clearTimeout(timer);
    }
    const excluded = Math.max(allowance, credit());
    settled = true;
    const ms = Date.now() - started;
    if (result === "timeout") {
      // The handler may still be running: close so no other handler starts on the same session.
      this.#answer(q, { text: this.#closedText("handler_timeout"), isError: true }, ms, false, seq);
      this.#violation("handler_timeout", `${q.name} ran longer than ${L.handlerTimeoutMs} ms (${ms} ms in all, ${excluded} ms allowed for user waits)`);
      this.close("handler_timeout");
      return;
    }
    this.#answer(q, { text: result.text, isError: result.isError }, ms, false, seq);
    if (typeof result.close === "string" && result.close !== "") this.close(result.close);
  }
}

/** Start a broker for one phase of one run. */
export async function startBroker(options: BrokerOptions): Promise<LoggingToolBroker> {
  const names = new Set<string>();
  for (const t of options.tools) {
    if (names.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
    names.add(t.name);
  }
  if (options.orchTag !== undefined && !isOrchTag(options.orchTag)) throw new Error("orchTag must be one line of at most 128 printable characters");
  const endpoint = await prepareEndpoint(options.dir);
  const server = createServer({ allowHalfOpen: false });
  const broker = new Broker(endpoint, server, options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => undefined);
  if (process.platform !== "win32") await chmod(endpoint, 0o600);
  return broker;
}

/**
 * The MCP call timeout (ms) a CLI must allow for these tools: the handler time plus 30 s, or 900 s when
 * a call may wait for the user (`ask_user` in scope, or `mayWaitForUser`).
 */
export function callTimeoutFor(toolNames: readonly string[], limits: Partial<BrokerLimits> = {}, options: { mayWaitForUser?: boolean } = {}): number {
  const handler = limits.handlerTimeoutMs ?? DEFAULT_BROKER_LIMITS.handlerTimeoutMs;
  const needsUser = options.mayWaitForUser === true || toolNames.some((n) => USER_WAIT_TOOLS.has(n));
  return Math.max(handler + 30_000, needsUser ? MCP_CALL_TIMEOUT_WITH_USER_MS : 0);
}

/**
 * The shim command for headless Node hosts (the agent CLI, evals): this package's `dist/stdio.js`
 * under the current Node, found from the package root whether this module runs from `dist/` or from
 * `src/` (the workspace's vitest alias). Throws when the shim is not built. The desktop app builds its
 * own (Electron with `ELECTRON_RUN_AS_NODE=1`).
 */
export function nodeShimCommand(): McpShimCommand {
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const shim = join(pkgRoot, "dist", "stdio.js");
  if (!existsSync(shim)) throw new Error(`the aicad-mcp shim is not built (${shim} is missing): run \`pnpm --filter @aicad/mcp-server build\``);
  return { command: process.execPath, args: [shim], env: {} };
}

/** `CliMcpHost` over {@link startBroker}: one broker per `open()`. */
export function createMcpHost(options: { shim: McpShimCommand }): CliMcpHost {
  const shim = options.shim;
  for (const k of Object.keys(shim.env)) {
    if (k === BRIDGE_TICKET_ENV || k === BRIDGE_ENDPOINT_ENV) throw new Error(`shim env must not set ${k}`);
  }
  return {
    async open(request: McpOpenRequest): Promise<CliMcpSession> {
      // `ToolRegistry.defs()` has no readOnly: fill it from READ_ONLY_TOOLS so the §6.2 hints stay right.
      const defs = withReadOnly(request.tools);
      if (READ_SCOPES.has(request.scope)) {
        const writing = defs.filter((d) => d.readOnly !== true).map((d) => d.name);
        if (writing.length > 0) throw new Error(`the ${request.scope} scope takes read-only tools only; not read-only: ${writing.join(", ")} (build the tools with registryToolDefs())`);
      }
      const tools = toBrokerTools(defs);
      const limits: Partial<BrokerLimits> = { ...(request.scope === "submit" ? SUBMIT_BROKER_LIMITS : {}), ...request.limits };
      const mayWaitForUser = request.mayWaitForUser === true;
      const broker = await startBroker({
        dir: request.dir,
        scope: request.scope,
        tools,
        instructions: request.instructions,
        handler: (call, control) => request.handler(call, control),
        limits,
        ...(request.onClose ? { onClose: (r: string) => request.onClose!(r) } : {}),
        ...(request.onViolation ? { onViolation: (v: { kind: string; detail: string }) => request.onViolation!(v) } : {}),
        ...(request.orchTag !== undefined ? { orchTag: request.orchTag } : {}),
        ...(mayWaitForUser ? { mayWaitForUser } : {}),
      });
      const toolNames = tools.map((t) => t.name);
      const attachment: McpAttachment = Object.freeze({
        serverName: "cad" as const,
        command: shim.command,
        args: Object.freeze([...shim.args]),
        env: Object.freeze({ ...shim.env, [BRIDGE_ENDPOINT_ENV]: broker.endpoint }),
        ticketEnv: "AICAD_MCP_TICKET" as const,
        toolNames: Object.freeze(toolNames),
        callTimeoutMs: callTimeoutFor(toolNames, limits, { mayWaitForUser }),
      });
      return {
        attachment,
        get ticket() {
          return broker.ticket;
        },
        get state() {
          return broker.state;
        },
        close: (reason: string) => broker.close(reason),
        dispose: () => broker.dispose(),
        log: () => broker.log().map(({ seq, name, isError, ms, text }) => ({ seq, name, isError, ms, text })),
      };
    },
  };
}

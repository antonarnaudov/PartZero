/**
 * The shim's side of the bridge (CLI-PROVIDERS.md §6.6): an {@link McpBackend} that forwards every
 * tool call to the host broker over the private socket.
 *
 * - On MCP `initialize`: connect, send `hello` (ticket + the MCP `clientInfo`), wait for `welcome`.
 * - Bridge unavailable (no endpoint or ticket, refused, denied, disconnected, timed out): the session
 *   still initializes (no tools), and every call answers `isError` with {@link HOST_UNAVAILABLE_TEXT}.
 *   The shim never hangs.
 * - Broker closed (§6.4 `closed` frame): once the broker ends the connection after its grace period,
 *   every call answers with the broker's closed text (the frame's `text`, which carries the run's
 *   orchestrator tag), not the unavailable text.
 * - Holds no state and no secrets beyond the ticket it read from its environment.
 *
 * No runtime dependencies beyond Node built-ins.
 */
import { connect, type Socket } from "node:net";
import {
  BRIDGE_PROTOCOL,
  closedText,
  encodeFrame,
  HOST_UNAVAILABLE_TEXT,
  isBridgeToolName,
  MAX_BRIDGE_FRAME_BYTES,
  parseHostMsg,
  type BridgeClientMsg,
  type BrokerTool,
} from "./bridge-protocol.js";
import { LineSplitter, type JsonRpcId } from "./jsonrpc.js";
import type { McpBackend, McpClientInfo, McpServerInfo, McpToolRequest } from "./mcp.js";
import { MCP_SERVER_VERSION } from "./version.js";

export interface BridgeBackendOptions {
  /** `AICAD_MCP_BRIDGE`. */
  endpoint: string | undefined;
  /** `AICAD_MCP_TICKET`. */
  ticket: string | undefined;
  pid: number;
  /** Diagnostics (the shim caps these). Never receives the ticket or the environment. */
  log?(line: string): void;
  /** Connect + welcome deadline. Default 10 s. */
  connectTimeoutMs?: number;
}

type Result = { text: string; isError: boolean };

const UNAVAILABLE: Result = { text: HOST_UNAVAILABLE_TEXT, isError: true };

export class BridgeBackend implements McpBackend {
  readonly #o: BridgeBackendOptions;
  #socket: Socket | null = null;
  #available = false;
  #nextId = 1;
  readonly #pending = new Map<number, (r: Result) => void>();
  /** MCP request id (JSON) → bridge call id, for cancellation. */
  readonly #byRequest = new Map<string, number>();
  #closedReason: string | null = null;
  #closedText = "";

  constructor(options: BridgeBackendOptions) {
    this.#o = options;
  }

  /** The broker said it is closing (calls still get the broker's closed text). */
  get closedReason(): string | null {
    return this.#closedReason;
  }

  /** What a call gets when the bridge is gone: the broker's closed text once it said it closed. */
  #gone(): Result {
    return this.#closedReason !== null ? { text: this.#closedText, isError: true } : UNAVAILABLE;
  }

  get available(): boolean {
    return this.#available;
  }

  async initialize(client: McpClientInfo | null): Promise<McpServerInfo> {
    const { endpoint, ticket } = this.#o;
    if (!endpoint || !ticket) {
      this.#o.log?.("bridge endpoint or ticket missing: serving no tools");
      return this.#unavailableInfo();
    }
    try {
      const welcome = await this.#connect(endpoint, ticket, client);
      return { version: welcome.version, instructions: welcome.instructions, tools: welcome.tools };
    } catch (e) {
      this.#o.log?.(`bridge unavailable: ${e instanceof Error ? e.message : String(e)}`);
      this.#fail();
      return this.#unavailableInfo();
    }
  }

  #unavailableInfo(): McpServerInfo {
    return { version: MCP_SERVER_VERSION, instructions: HOST_UNAVAILABLE_TEXT, tools: [] };
  }

  #connect(endpoint: string, ticket: string, client: McpClientInfo | null): Promise<{ version: string; instructions: string; tools: BrokerTool[] }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = connect(endpoint);
      this.#socket = socket;
      const timer = setTimeout(() => done(new Error("timed out waiting for the host")), this.#o.connectTimeoutMs ?? 10_000);
      const done = (err: Error | null, welcome?: { version: string; instructions: string; tools: BrokerTool[] }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(welcome!);
      };
      const splitter = new LineSplitter(
        (line) => {
          const p = parseHostMsg(line);
          if (!p.ok) {
            this.#o.log?.(`bridge protocol error: ${p.error}`);
            this.#fail();
            done(new Error("protocol error"));
            return;
          }
          const m = p.msg;
          switch (m.t) {
            case "welcome":
              if (this.#available) {
                this.#fail();
                return;
              }
              this.#available = true;
              done(null, { version: m.server.version, instructions: m.instructions, tools: m.tools });
              return;
            case "denied":
              this.#o.log?.(`bridge denied: ${m.reason}`);
              this.#fail();
              done(new Error(`denied (${m.reason})`));
              return;
            case "closed":
              this.#closedReason = m.reason;
              this.#closedText = m.text ?? closedText(m.reason);
              return;
            case "result": {
              const r = this.#pending.get(m.id);
              if (!r) return;
              this.#pending.delete(m.id);
              r({ text: m.text, isError: m.isError });
              return;
            }
          }
        },
        () => {
          this.#o.log?.("bridge frame too large");
          this.#fail();
          done(new Error("frame too large"));
        },
        MAX_BRIDGE_FRAME_BYTES,
      );
      socket.on("connect", () => {
        this.#write({ t: "hello", v: BRIDGE_PROTOCOL, ticket, pid: this.#o.pid, client });
      });
      socket.on("data", (chunk: Buffer) => splitter.push(chunk));
      socket.on("error", (e) => done(e));
      socket.on("close", () => {
        this.#fail();
        done(new Error("disconnected"));
      });
    });
  }

  #write(msg: BridgeClientMsg): "sent" | "gone" | "too_large" {
    const s = this.#socket;
    if (!s || s.destroyed || !s.writable) return "gone";
    const frame = encodeFrame(msg);
    if (Buffer.byteLength(frame, "utf8") > MAX_BRIDGE_FRAME_BYTES + 1) return "too_large";
    s.write(frame);
    return "sent";
  }

  /** The bridge is gone: every pending and later call gets the unavailable text (the closed text after a close). */
  #fail(): void {
    this.#available = false;
    const s = this.#socket;
    if (s && !s.destroyed) s.destroy();
    const gone = this.#gone();
    for (const r of this.#pending.values()) r(gone);
    this.#pending.clear();
  }

  callTool(request: McpToolRequest, requestId: JsonRpcId): Promise<Result> {
    if (!this.#available) return Promise.resolve(this.#gone());
    // A name the bridge cannot carry is no tool of ours; answer here rather than break the bridge.
    if (!isBridgeToolName(request.name)) return Promise.resolve({ text: `Unknown tool "${request.name.slice(0, 64)}".`, isError: true });
    const id = this.#nextId++;
    const key = JSON.stringify(requestId);
    return new Promise<Result>((resolve) => {
      this.#pending.set(id, resolve);
      this.#byRequest.set(key, id);
      const sent = this.#write({ t: "call", id, name: request.name, args: request.args, toolUseId: request.toolUseId });
      if (sent !== "sent") {
        this.#pending.delete(id);
        resolve(sent === "gone" ? this.#gone() : { text: "Not executed: the arguments are too large for the CAD host. Send smaller edits (patches).", isError: true });
      }
    }).finally(() => this.#byRequest.delete(key));
  }

  cancel(requestId: JsonRpcId): void {
    const id = this.#byRequest.get(JSON.stringify(requestId));
    if (id !== undefined) this.#write({ t: "cancel", id });
  }

  close(): void {
    this.#write({ t: "bye" });
    const s = this.#socket;
    if (s && !s.destroyed) s.end();
    this.#available = false;
    const gone = this.#gone();
    for (const r of this.#pending.values()) r(gone);
    this.#pending.clear();
  }
}

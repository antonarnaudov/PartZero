import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Readable, Writable } from "node:stream";
import { encodeFrame, parseHostMsg, type BridgeClientMsg, type BridgeHostMsg } from "../../src/bridge-protocol.js";
import { LineSplitter } from "../../src/jsonrpc.js";
import { McpConnection, type McpBackend } from "../../src/mcp.js";

export const PKG_DIR = fileURLToPath(new URL("../../", import.meta.url));
/** The built shim (the package's test script builds dist/ first). */
export const SHIM = join(PKG_DIR, "dist", "stdio.js");

/** A short private temp dir (socket paths must stay under 104 bytes). Removed by the returned cleanup. */
export function shortTmp(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "aicad-mcp-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until `pred()` is true (polling), or fail after `ms`. */
export async function until(pred: () => boolean, ms = 3_000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

/** A raw bridge client for broker tests: send frames, collect the host's frames. */
export class RawBridge {
  readonly socket: Socket;
  readonly frames: BridgeHostMsg[] = [];
  readonly bad: string[] = [];
  closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    const splitter = new LineSplitter(
      (line) => {
        const p = parseHostMsg(line);
        if (p.ok) this.frames.push(p.msg);
        else this.bad.push(line);
      },
      () => this.bad.push("<oversize>"),
    );
    socket.on("data", (c: Buffer) => splitter.push(c));
    socket.on("close", () => (this.closed = true));
    socket.on("error", () => undefined);
  }

  static open(endpoint: string): Promise<RawBridge> {
    return new Promise((resolve, reject) => {
      const s = connect(endpoint);
      s.once("connect", () => resolve(new RawBridge(s)));
      s.once("error", reject);
    });
  }

  send(msg: BridgeClientMsg): void {
    this.socket.write(encodeFrame(msg));
  }

  raw(text: string): void {
    this.socket.write(text);
  }

  async hello(ticket: string, client: { name: string; version: string } | null = { name: "test", version: "1" }): Promise<BridgeHostMsg> {
    const n = this.frames.length;
    this.send({ t: "hello", v: 1, ticket, pid: process.pid, client });
    await until(() => this.frames.length > n || this.closed, 3_000, "welcome");
    return this.frames[n] ?? { t: "denied", reason: "protocol" };
  }

  /** Send a call and wait for its result. */
  async call(id: number, name: string, args: Record<string, unknown> = {}, toolUseId: string | null = null): Promise<{ text: string; isError: boolean }> {
    this.send({ t: "call", id, name, args, toolUseId });
    return this.result(id);
  }

  async result(id: number, ms = 5_000): Promise<{ text: string; isError: boolean }> {
    await until(() => this.frames.some((f) => f.t === "result" && f.id === id) || this.closed, ms, `result ${id}`);
    const f = this.frames.find((x) => x.t === "result" && x.id === id);
    if (!f || f.t !== "result") throw new Error(`no result for ${id} (connection closed)`);
    return { text: f.text, isError: f.isError };
  }

  close(): void {
    this.socket.destroy();
  }
}

/** An official SDK client connected in-process to one {@link McpConnection} over `backend`. */
export async function inProcessClient(backend: McpBackend, name = "test-client"): Promise<{ client: Client; connection: McpConnection; close(): Promise<void> }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const connection = new McpConnection(backend);
  serverT.onmessage = (msg: JSONRPCMessage) => {
    void connection.receive(JSON.stringify(msg)).then((res) => {
      if (res) void serverT.send(res as JSONRPCMessage);
    });
  };
  serverT.onclose = () => connection.close();
  await serverT.start();
  const client = new Client({ name, version: "9.9.9" });
  await client.connect(clientT);
  return {
    client,
    connection,
    close: async () => {
      await client.close();
    },
  };
}

/** An SDK client transport over two streams (the server side of an in-process stdio pair). */
export class StreamClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #toServer: Writable;
  readonly #fromServer: Readable;
  readonly #buf = new ReadBuffer();

  constructor(toServer: Writable, fromServer: Readable) {
    this.#toServer = toServer;
    this.#fromServer = fromServer;
  }

  async start(): Promise<void> {
    this.#fromServer.on("data", (c: Buffer) => {
      this.#buf.append(c);
      for (let m = this.#buf.readMessage(); m; m = this.#buf.readMessage()) this.onmessage?.(m);
    });
    this.#fromServer.on("end", () => this.onclose?.());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.#toServer.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.#toServer.end();
    this.onclose?.();
  }
}

/** The text of one `resources/read` content item ("" for a blob). */
export function resourceText(c: object): string {
  return "text" in c && typeof c.text === "string" ? c.text : "";
}

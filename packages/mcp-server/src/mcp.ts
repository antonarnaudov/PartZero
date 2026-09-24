/**
 * The small MCP server subset the `cad` server needs (CLI-PROVIDERS.md §6.1, §6.6), over any
 * transport: `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/initialized`,
 * `notifications/cancelled`, and — only when the backend has resources (the external design host,
 * ARCHITECTURE §9) — `resources/list`, `resources/templates/list` and `resources/read`.
 * Every other method answers JSON-RPC `-32601`; unknown notifications are ignored.
 *
 * The protocol logic does not know where tools run: a {@link McpBackend} does. The stdio shim's
 * backend forwards to the host broker over the bridge; the design host's backend runs the tools on
 * an in-process `DesignSession` branch.
 *
 * No runtime dependencies (the shim imports it).
 */
import type { Readable, Writable } from "node:stream";
import type { BrokerTool } from "./bridge-protocol.js";
import {
  classify,
  failure,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  LineSplitter,
  MAX_FRAME_BYTES,
  success,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";

/** Newest first. A client asking for one of these gets it echoed; any other gets the newest. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];

/** MCP's "resource not found" error code. */
export const MCP_RESOURCE_NOT_FOUND = -32002;

/** Server-defined JSON-RPC error: the host refused the request (closed, gated, rate limited). */
export const MCP_REQUEST_REFUSED = -32003;

/**
 * Thrown by a backend's resource methods to answer with a JSON-RPC error and a message the client may
 * show (any other exception becomes a generic internal error).
 */
export class McpRequestError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "McpRequestError";
    this.code = code;
  }
}

export interface McpClientInfo {
  name: string;
  version: string;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export interface McpServerInfo {
  /** The server version announced in `serverInfo` (the name is always `cad`). */
  version: string;
  instructions: string;
  tools: readonly BrokerTool[];
  /** Announce the `resources` capability (the backend implements {@link McpBackend.resources}). */
  resources?: boolean;
}

export interface McpToolRequest {
  name: string;
  args: Record<string, unknown>;
  /** The client's id for this call when it sends one (Claude Code: `_meta["claudecode/toolUseId"]`). */
  toolUseId: string | null;
}

export interface McpBackend {
  /** Called once, on `initialize`, with the client's `clientInfo`. */
  initialize(client: McpClientInfo | null): Promise<McpServerInfo>;
  /** Run (or refuse) one call. Every call is forwarded, including unknown names: the backend decides. */
  callTool(request: McpToolRequest, requestId: JsonRpcId): Promise<{ text: string; isError: boolean }>;
  /** `notifications/cancelled` for an in-flight call (advisory). */
  cancel?(requestId: JsonRpcId): void;
  /** Each method may throw {@link McpRequestError} to refuse the request with a message. */
  resources?: {
    list(): Promise<McpResource[]>;
    templates(): McpResourceTemplate[];
    /** `null` when there is no such resource. */
    read(uri: string): Promise<McpResourceContents[] | null>;
  };
  /** The transport ended (stdin EOF, SIGTERM, client closed). */
  close?(): void;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clientInfoOf(params: Record<string, unknown> | undefined): McpClientInfo | null {
  const c = params?.["clientInfo"];
  if (!isPlainObject(c) || typeof c["name"] !== "string") return null;
  return { name: c["name"].slice(0, 128), version: typeof c["version"] === "string" ? c["version"].slice(0, 64) : "" };
}

function toolUseIdOf(params: Record<string, unknown>): string | null {
  const meta = params["_meta"];
  if (!isPlainObject(meta)) return null;
  const id = meta["claudecode/toolUseId"];
  return typeof id === "string" && id.length <= 256 ? id : null;
}

/**
 * One MCP server connection: feed it inbound frames, it returns the response to write (or nothing).
 * Tool calls run concurrently at this layer; backends serialize where they must.
 */
export class McpConnection {
  readonly #backend: McpBackend;
  #info: McpServerInfo | null = null;
  #initializing = false;
  #ready: Promise<void> = Promise.resolve();
  #client: McpClientInfo | null = null;
  #protocolVersion: string | null = null;
  /** In-flight tools/call request ids (keyed by JSON so 1 and "1" differ). */
  readonly #inFlight = new Map<string, JsonRpcId>();
  readonly #cancelled = new Set<string>();

  constructor(backend: McpBackend) {
    this.#backend = backend;
  }

  get client(): McpClientInfo | null {
    return this.#client;
  }
  get protocolVersion(): string | null {
    return this.#protocolVersion;
  }
  get initialized(): boolean {
    return this.#info !== null;
  }

  /** Handle one frame. Resolves to the response to send, or undefined (notifications, cancelled calls). */
  async receive(line: string): Promise<JsonRpcResponse | undefined> {
    const inbound = classify(line);
    switch (inbound.kind) {
      case "invalid":
        return failure(inbound.id, inbound.code, inbound.message);
      case "response":
        return undefined; // we never send requests
      case "notification":
        this.#notification(inbound.msg.method, inbound.msg.params);
        return undefined;
      case "request":
        return this.#request(inbound.msg);
    }
  }

  #notification(method: string, params: Record<string, unknown> | undefined): void {
    if (method !== "notifications/cancelled") return; // initialized, progress, roots/list_changed, …: nothing to do
    const id = params?.["requestId"];
    if (typeof id !== "string" && typeof id !== "number") return;
    const key = JSON.stringify(id);
    if (!this.#inFlight.has(key)) return;
    this.#cancelled.add(key);
    this.#backend.cancel?.(id);
  }

  async #request(req: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const { id, method } = req;
    const params = req.params ?? {};
    if (method === "ping") return success(id, {});
    if (method === "initialize") return this.#initialize(id, params);
    // A request pipelined behind initialize waits for it instead of failing.
    if (!this.#info && this.#initializing) await this.#ready;
    if (!this.#info) return failure(id, JSONRPC_INVALID_REQUEST, "Server not initialized");
    switch (method) {
      case "tools/list":
        return success(id, {
          tools: this.#info.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
        });
      case "tools/call":
        return this.#call(id, params);
      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
        if (!this.#info.resources || !this.#backend.resources) return failure(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
        return this.#resources(id, method, params, this.#backend.resources);
      default:
        return failure(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 64)}`);
    }
  }

  async #initialize(id: JsonRpcId, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (this.#info || this.#initializing) return failure(id, JSONRPC_INVALID_REQUEST, "Already initialized");
    this.#initializing = true;
    let settle!: () => void;
    this.#ready = new Promise<void>((r) => (settle = r));
    try {
      return await this.#doInitialize(id, params);
    } finally {
      this.#initializing = false;
      settle();
    }
  }

  async #doInitialize(id: JsonRpcId, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const asked = params["protocolVersion"];
    const version = typeof asked === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_LATEST_PROTOCOL_VERSION;
    this.#client = clientInfoOf(params);
    let info: McpServerInfo;
    try {
      info = await this.#backend.initialize(this.#client);
    } catch {
      return failure(id, JSONRPC_INTERNAL_ERROR, "The CAD host could not start this session.");
    }
    this.#info = info;
    this.#protocolVersion = version;
    const capabilities: Record<string, unknown> = { tools: { listChanged: false } };
    if (info.resources && this.#backend.resources) capabilities["resources"] = { listChanged: false, subscribe: false };
    return success(id, {
      protocolVersion: version,
      capabilities,
      serverInfo: { name: "cad", version: info.version },
      instructions: info.instructions,
    });
  }

  async #call(id: JsonRpcId, params: Record<string, unknown>): Promise<JsonRpcResponse | undefined> {
    const name = params["name"];
    const args = params["arguments"] ?? {};
    if (typeof name !== "string" || name.length === 0 || name.length > 128) return failure(id, JSONRPC_INVALID_PARAMS, "tools/call needs a tool name");
    if (!isPlainObject(args)) return failure(id, JSONRPC_INVALID_PARAMS, "tools/call arguments must be an object");
    const key = JSON.stringify(id);
    if (this.#inFlight.has(key)) return failure(id, JSONRPC_INVALID_REQUEST, "Duplicate request id");
    this.#inFlight.set(key, id);
    let out: { text: string; isError: boolean };
    try {
      out = await this.#backend.callTool({ name, args, toolUseId: toolUseIdOf(params) }, id);
    } catch {
      out = { text: "The CAD host failed to run this tool.", isError: true };
    } finally {
      this.#inFlight.delete(key);
    }
    if (this.#cancelled.delete(key)) return undefined; // the client cancelled: no response (MCP cancellation rules)
    return success(id, { content: [{ type: "text", text: out.text }], isError: out.isError });
  }

  async #resources(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
    resources: NonNullable<McpBackend["resources"]>,
  ): Promise<JsonRpcResponse> {
    try {
      if (method === "resources/list") return success(id, { resources: await resources.list() });
      if (method === "resources/templates/list") return success(id, { resourceTemplates: resources.templates() });
      const uri = params["uri"];
      if (typeof uri !== "string" || uri.length > 512) return failure(id, JSONRPC_INVALID_PARAMS, "resources/read needs a uri");
      const contents = await resources.read(uri);
      if (!contents) return failure(id, MCP_RESOURCE_NOT_FOUND, `Resource not found: ${uri}`);
      return success(id, { contents });
    } catch (e) {
      if (e instanceof McpRequestError) return failure(id, e.code, e.message.slice(0, 1024));
      return failure(id, JSONRPC_INTERNAL_ERROR, "The CAD host could not read this resource.");
    }
  }

  /** The transport ended. */
  close(): void {
    this.#backend.close?.();
  }
}

export interface ServeStreamsOptions {
  backend: McpBackend;
  input: Readable;
  output: Writable;
}

/**
 * Serve one MCP connection over newline-delimited streams (stdio). Resolves when the input ends;
 * the backend is closed then. stdout carries JSON-RPC frames only.
 */
export function serveStreams(options: ServeStreamsOptions): { connection: McpConnection; done: Promise<void> } {
  const connection = new McpConnection(options.backend);
  const out = options.output;
  const write = (msg: JsonRpcResponse | undefined): void => {
    if (msg && out.writable) out.write(JSON.stringify(msg) + "\n");
  };
  const splitter = new LineSplitter(
    (line) => {
      connection.receive(line).then(write, () => write(failure(null, JSONRPC_INTERNAL_ERROR, "Internal error")));
    },
    () => write(failure(null, JSONRPC_INVALID_REQUEST, `Frame larger than ${MAX_FRAME_BYTES} bytes`)),
  );
  const done = new Promise<void>((resolve) => {
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      splitter.end();
      connection.close();
      resolve();
    };
    options.input.on("data", (chunk: Buffer | string) => splitter.push(chunk));
    options.input.on("end", end);
    options.input.on("close", end);
    options.input.on("error", end);
  });
  return { connection, done };
}

/**
 * Newline-delimited JSON-RPC 2.0 for the MCP stdio transport (and the NDJSON bridge): a bounded line
 * splitter and a strict message classifier. No runtime dependencies (the shim imports it).
 *
 * - Frames are at most {@link MAX_FRAME_BYTES} (1 MiB). A longer line is discarded as it streams in
 *   (it is never buffered whole) and reported once, so the caller can answer `-32600` with id null.
 * - Batches (JSON arrays) are not supported: MCP removed them in 2025-06-18.
 */

export const MAX_FRAME_BYTES = 1024 * 1024;

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** What one inbound frame is. */
export type Inbound =
  | { kind: "request"; msg: JsonRpcRequest }
  | { kind: "notification"; msg: JsonRpcNotification }
  | { kind: "response"; msg: JsonRpcResponse }
  /** A frame that must be answered with an error (id null when the id could not be read). */
  | { kind: "invalid"; id: JsonRpcId | null; code: number; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is JsonRpcId {
  return (typeof v === "string" && v.length <= 256) || (typeof v === "number" && Number.isFinite(v));
}

/** Classify one frame (already split on newlines). Never throws. */
export function classify(line: string): Inbound {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { kind: "invalid", id: null, code: JSONRPC_PARSE_ERROR, message: "Parse error" };
  }
  if (Array.isArray(v)) return { kind: "invalid", id: null, code: JSONRPC_INVALID_REQUEST, message: "Batches are not supported" };
  if (!isPlainObject(v) || v["jsonrpc"] !== "2.0") return { kind: "invalid", id: isPlainObject(v) && isId(v["id"]) ? v["id"] : null, code: JSONRPC_INVALID_REQUEST, message: "Invalid Request" };
  const hasId = Object.hasOwn(v, "id");
  const id = v["id"];
  if (typeof v["method"] === "string") {
    const params = v["params"];
    if (params !== undefined && !isPlainObject(params)) {
      return hasId && isId(id) ? { kind: "invalid", id, code: JSONRPC_INVALID_PARAMS, message: "params must be an object" } : { kind: "invalid", id: null, code: JSONRPC_INVALID_REQUEST, message: "Invalid Request" };
    }
    const base = params === undefined ? { jsonrpc: "2.0" as const, method: v["method"] } : { jsonrpc: "2.0" as const, method: v["method"], params };
    if (!hasId) return { kind: "notification", msg: base };
    if (!isId(id)) return { kind: "invalid", id: null, code: JSONRPC_INVALID_REQUEST, message: "Invalid id" };
    return { kind: "request", msg: { ...base, id } };
  }
  if (hasId && (id === null || isId(id)) && (Object.hasOwn(v, "result") || Object.hasOwn(v, "error"))) {
    return { kind: "response", msg: v as unknown as JsonRpcResponse };
  }
  return { kind: "invalid", id: isId(id) ? id : null, code: JSONRPC_INVALID_REQUEST, message: "Invalid Request" };
}

export function success(id: JsonRpcId, result: Record<string, unknown>): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function failure(id: JsonRpcId | null, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Splits a byte stream into newline-terminated UTF-8 lines of at most `maxBytes`. An over-long line
 * is dropped as it streams in and reported through `onOversize`. `\r\n` is accepted. Empty lines are
 * skipped.
 */
export class LineSplitter {
  readonly #maxBytes: number;
  readonly #onLine: (line: string) => void;
  readonly #onOversize: () => void;
  #parts: Buffer[] = [];
  #size = 0;
  #skipping = false;

  constructor(onLine: (line: string) => void, onOversize: () => void, maxBytes = MAX_FRAME_BYTES) {
    this.#onLine = onLine;
    this.#onOversize = onOversize;
    this.#maxBytes = maxBytes;
  }

  push(chunk: Buffer | string): void {
    let buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        this.#append(buf);
        return;
      }
      this.#append(buf.subarray(0, nl));
      this.#emit();
      buf = buf.subarray(nl + 1);
    }
  }

  /** End of stream: a trailing unterminated line is emitted. */
  end(): void {
    if (this.#size > 0 || this.#skipping) this.#emit();
  }

  #append(part: Buffer): void {
    if (part.length === 0 || this.#skipping) return;
    if (this.#size + part.length > this.#maxBytes + 1) {
      // +1 tolerates a trailing \r on a line of exactly maxBytes.
      this.#skipping = true;
      this.#parts = [];
      this.#size = 0;
      return;
    }
    this.#parts.push(part);
    this.#size += part.length;
  }

  #emit(): void {
    if (this.#skipping) {
      this.#skipping = false;
      this.#onOversize();
      return;
    }
    let line = Buffer.concat(this.#parts, this.#size).toString("utf8");
    this.#parts = [];
    this.#size = 0;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (Buffer.byteLength(line, "utf8") > this.#maxBytes) {
      this.#onOversize();
      return;
    }
    if (line.trim() !== "") this.#onLine(line);
  }
}

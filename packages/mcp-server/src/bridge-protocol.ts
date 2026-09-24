/**
 * The host ⇄ shim bridge protocol, version 1 (FROZEN: CLI-PROVIDERS.md §6.4).
 *
 * Transport: a Unix domain socket `<socketDir>/b.sock` in a 0700 directory (Windows: a named pipe).
 * The shim reads the endpoint from `AICAD_MCP_BRIDGE` and the ticket from `AICAD_MCP_TICKET`.
 * Framing: newline-delimited JSON, frames ≤ 1 MiB.
 *
 * This module has no runtime dependencies: the shim imports it.
 */
import type { McpScope } from "./types.js";

export const BRIDGE_PROTOCOL = 1;

/** Largest bridge frame, in bytes, excluding the newline. */
export const MAX_BRIDGE_FRAME_BYTES = 1024 * 1024;

export const BRIDGE_ENDPOINT_ENV = "AICAD_MCP_BRIDGE";
export const BRIDGE_TICKET_ENV = "AICAD_MCP_TICKET";

export type BridgeClientMsg =
  | { t: "hello"; v: 1; ticket: string; pid: number; client: { name: string; version: string } | null } // client = MCP clientInfo
  | { t: "call"; id: number; name: string; args: Record<string, unknown>; toolUseId: string | null }
  | { t: "cancel"; id: number } // from notifications/cancelled; advisory
  | { t: "bye" };

export type BridgeHostMsg =
  | { t: "welcome"; v: 1; scope: McpScope; server: { name: "cad"; version: string }; instructions: string; tools: BrokerTool[] }
  | { t: "result"; id: number; text: string; isError: boolean }
  // Broker closing: later calls get the closed text. `text` (additive, optional) is that exact text, with
  // the run's orchestrator tag; the shim answers with it once the bridge is gone.
  | { t: "closed"; reason: string; text?: string }
  | { t: "denied"; reason: "bad_ticket" | "too_many_connections" | "protocol" | "closed" };

export interface BrokerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

/**
 * What every call gets once the broker is closed (CLI-PROVIDERS.md §3.3, stop rules). The `<orch>`
 * placeholder is replaced by the run's orchestrator tag: use {@link closedText}.
 */
export function BROKER_CLOSED_TEXT(reason: string): string {
  return `<orch> The task has ended (${reason}). Do not call any more tools; reply with one short line.`;
}

/** The placeholder in texts the host writes for the orchestrator ({@link BROKER_CLOSED_TEXT}). */
export const ORCH_PLACEHOLDER = "<orch>";

/** Longest orchestrator tag a host may pass (the agent's is `[orchestrator <nonce>]`). */
export const MAX_ORCH_TAG_CHARS = 128;

/** True when `tag` can stand in for `<orch>`: one line of printable text, at most {@link MAX_ORCH_TAG_CHARS}. */
export function isOrchTag(tag: string): boolean {
  // eslint-disable-next-line no-control-regex
  return tag.length > 0 && tag.length <= MAX_ORCH_TAG_CHARS && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(tag) && !tag.includes(ORCH_PLACEHOLDER);
}

/**
 * `text` with every `<orch>` replaced by the run's orchestrator tag, or removed (with the space after
 * it) when there is none: a literal `<orch>` means nothing to a model. Only for texts the host itself
 * wrote. Never apply it to handler results: those can echo model-written text, and substituting there
 * would let the model forge an orchestrator note.
 */
export function withOrchTag(text: string, tag: string | null | undefined): string {
  if (!text.includes(ORCH_PLACEHOLDER)) return text;
  if (tag) return text.split(ORCH_PLACEHOLDER).join(tag);
  return text.split(`${ORCH_PLACEHOLDER} `).join("").split(ORCH_PLACEHOLDER).join("");
}

/** {@link BROKER_CLOSED_TEXT} with the orchestrator tag in place of `<orch>` (see {@link withOrchTag}). */
export function closedText(reason: string, tag?: string | null): string {
  return withOrchTag(BROKER_CLOSED_TEXT(reason), tag);
}

/** Longest `text` a `closed` frame may carry. */
export const MAX_CLOSED_TEXT_CHARS = 1024;

/** What the shim answers when it cannot reach the host (§6.6 rule 4). */
export const HOST_UNAVAILABLE_TEXT = "The CAD host is unavailable; stop calling tools.";

// ─── Strict parsing ──────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(o: Json, required: readonly string[]): boolean {
  const keys = Object.keys(o);
  return keys.length === required.length && required.every((k) => Object.hasOwn(o, k));
}

/** A non-negative safe integer (bridge call ids, pids). */
function isId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const TICKET = /^[0-9a-f]{64}$/;

export type Parsed<T> = { ok: true; msg: T } | { ok: false; error: string };

function parseJsonFrame(line: string): Parsed<Json> {
  if (Buffer.byteLength(line, "utf8") > MAX_BRIDGE_FRAME_BYTES) return { ok: false, error: "frame too large" };
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!isPlainObject(v)) return { ok: false, error: "not an object" };
  return { ok: true, msg: v };
}

/** Validate one frame the shim sent. Unknown or malformed frames are protocol errors. */
export function parseClientMsg(line: string): Parsed<BridgeClientMsg> {
  const p = parseJsonFrame(line);
  if (!p.ok) return p;
  const m = p.msg;
  switch (m["t"]) {
    case "hello": {
      if (!hasExactKeys(m, ["t", "v", "ticket", "pid", "client"])) return { ok: false, error: "hello: bad keys" };
      if (m["v"] !== BRIDGE_PROTOCOL) return { ok: false, error: "hello: unsupported version" };
      if (typeof m["ticket"] !== "string" || m["ticket"].length > 256) return { ok: false, error: "hello: bad ticket" };
      if (!isId(m["pid"])) return { ok: false, error: "hello: bad pid" };
      const c = m["client"];
      let client: { name: string; version: string } | null = null;
      if (c !== null) {
        if (!isPlainObject(c) || typeof c["name"] !== "string" || typeof c["version"] !== "string") return { ok: false, error: "hello: bad client" };
        client = { name: c["name"].slice(0, 128), version: c["version"].slice(0, 64) };
      }
      return { ok: true, msg: { t: "hello", v: 1, ticket: m["ticket"], pid: m["pid"], client } };
    }
    case "call": {
      if (!hasExactKeys(m, ["t", "id", "name", "args", "toolUseId"])) return { ok: false, error: "call: bad keys" };
      if (!isId(m["id"])) return { ok: false, error: "call: bad id" };
      if (typeof m["name"] !== "string" || !TOOL_NAME.test(m["name"])) return { ok: false, error: "call: bad name" };
      if (!isPlainObject(m["args"])) return { ok: false, error: "call: args must be an object" };
      const tu = m["toolUseId"];
      if (tu !== null && (typeof tu !== "string" || tu.length > 256)) return { ok: false, error: "call: bad toolUseId" };
      return { ok: true, msg: { t: "call", id: m["id"], name: m["name"], args: m["args"], toolUseId: tu } };
    }
    case "cancel":
      if (!hasExactKeys(m, ["t", "id"]) || !isId(m["id"])) return { ok: false, error: "cancel: bad frame" };
      return { ok: true, msg: { t: "cancel", id: m["id"] } };
    case "bye":
      if (!hasExactKeys(m, ["t"])) return { ok: false, error: "bye: bad keys" };
      return { ok: true, msg: { t: "bye" } };
    default:
      return { ok: false, error: "unknown frame type" };
  }
}

function isBrokerTool(v: unknown): v is BrokerTool {
  if (!isPlainObject(v)) return false;
  const a = v["annotations"];
  return (
    typeof v["name"] === "string" &&
    TOOL_NAME.test(v["name"]) &&
    typeof v["description"] === "string" &&
    isPlainObject(v["inputSchema"]) &&
    isPlainObject(a) &&
    typeof a["readOnlyHint"] === "boolean" &&
    typeof a["destructiveHint"] === "boolean" &&
    typeof a["idempotentHint"] === "boolean" &&
    typeof a["openWorldHint"] === "boolean"
  );
}

const SCOPES: ReadonlySet<string> = new Set(["spec", "design", "read", "submit", "ext-read", "ext-edit", "ext-export"]);
const DENIALS: ReadonlySet<string> = new Set(["bad_ticket", "too_many_connections", "protocol", "closed"]);

/** Validate one frame the broker sent (the shim treats anything else as a broken bridge). */
export function parseHostMsg(line: string): Parsed<BridgeHostMsg> {
  const p = parseJsonFrame(line);
  if (!p.ok) return p;
  const m = p.msg;
  switch (m["t"]) {
    case "welcome": {
      const server = m["server"];
      const tools = m["tools"];
      if (m["v"] !== BRIDGE_PROTOCOL || typeof m["scope"] !== "string" || !SCOPES.has(m["scope"])) return { ok: false, error: "welcome: bad header" };
      if (!isPlainObject(server) || server["name"] !== "cad" || typeof server["version"] !== "string") return { ok: false, error: "welcome: bad server" };
      if (typeof m["instructions"] !== "string" || !Array.isArray(tools) || !tools.every(isBrokerTool)) return { ok: false, error: "welcome: bad tools" };
      return {
        ok: true,
        msg: { t: "welcome", v: 1, scope: m["scope"] as McpScope, server: { name: "cad", version: server["version"] }, instructions: m["instructions"], tools },
      };
    }
    case "result":
      if (!isId(m["id"]) || typeof m["text"] !== "string" || typeof m["isError"] !== "boolean") return { ok: false, error: "result: bad frame" };
      return { ok: true, msg: { t: "result", id: m["id"], text: m["text"], isError: m["isError"] } };
    case "closed": {
      const text = m["text"];
      if (typeof m["reason"] !== "string") return { ok: false, error: "closed: bad frame" };
      if (text !== undefined && (typeof text !== "string" || text.length > MAX_CLOSED_TEXT_CHARS)) return { ok: false, error: "closed: bad text" };
      return { ok: true, msg: typeof text === "string" ? { t: "closed", reason: m["reason"], text } : { t: "closed", reason: m["reason"] } };
    }
    case "denied":
      if (typeof m["reason"] !== "string" || !DENIALS.has(m["reason"])) return { ok: false, error: "denied: bad frame" };
      return { ok: true, msg: { t: "denied", reason: m["reason"] as "bad_ticket" | "too_many_connections" | "protocol" | "closed" } };
    default:
      return { ok: false, error: "unknown frame type" };
  }
}

/** True when `name` can travel in a bridge `call` frame. */
export function isBridgeToolName(name: string): boolean {
  return TOOL_NAME.test(name);
}

/** True when `ticket` has the broker's shape (32 random bytes, lowercase hex). */
export function isTicketShape(ticket: string): boolean {
  return TICKET.test(ticket);
}

/** One frame on the wire. */
export function encodeFrame(msg: BridgeClientMsg | BridgeHostMsg): string {
  return JSON.stringify(msg) + "\n";
}

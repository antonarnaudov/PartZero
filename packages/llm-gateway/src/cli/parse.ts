import { emptyUsage, type Usage } from "../types.js";

/**
 * Defensive helpers for untrusted CLI output (docs/CLI-PROVIDERS.md §5.7). Event strings are data only; model names
 * and session ids are validated before they are kept or reused in argv; numbers must be finite and >= 0.
 */

export function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Finite and >= 0, else null. */
export function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** A model name that is safe to keep and to pass in argv: never starts with "-" (it could be read as a flag). */
export function safeModel(v: unknown): string | null {
  return typeof v === "string" && /^(?!-)[\w.:/@-]{1,128}$/.test(v) ? v : null;
}

/** A session id that is safe to reuse in argv: never starts with "-". */
export function safeSessionId(v: unknown): string | null {
  return typeof v === "string" && /^(?!-)[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null;
}

/** An effort value from a profile's `effortArg` (`high`, `xhigh`): a short word, never a flag. */
export function safeArgWord(v: unknown): string | null {
  return typeof v === "string" && /^(?!-)[\w.-]{1,32}$/.test(v) ? v : null;
}

/** Text content of a tool result: a string or an array of `{type:"text", text}` parts. */
export function textContent(v: unknown, max = 65_536): string {
  if (typeof v === "string") return v.slice(0, max);
  if (Array.isArray(v)) {
    return v
      .map((p) => {
        const r = rec(p);
        return typeof r["text"] === "string" ? r["text"] : "";
      })
      .filter((s) => s.length > 0)
      .join("\n")
      .slice(0, max);
  }
  return "";
}

export function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (a === null) return b === null ? null : { ...b };
  if (b === null) return { ...a };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** Anthropic-shaped usage (`input_tokens`, `cache_read_input_tokens`, ...) -> Usage. */
export function anthropicUsage(v: unknown): Usage | null {
  const u = rec(v);
  if (Object.keys(u).length === 0) return null;
  const out = emptyUsage();
  out.inputTokens = count(u["input_tokens"]) ?? 0;
  out.outputTokens = count(u["output_tokens"]) ?? 0;
  out.cacheReadTokens = count(u["cache_read_input_tokens"]) ?? 0;
  out.cacheWriteTokens = count(u["cache_creation_input_tokens"]) ?? 0;
  out.cacheWrite1hTokens = count(rec(u["cache_creation"])["ephemeral_1h_input_tokens"]) ?? 0;
  return out;
}

/** Tools the model sees as `<prefix><tool>`: split a qualified name back into server and tool. */
export function splitPrefixed(name: string, prefix: string, server: string): { server: string | null; tool: string } {
  return name.startsWith(prefix) && name.length > prefix.length ? { server, tool: name.slice(prefix.length) } : { server: null, tool: name };
}

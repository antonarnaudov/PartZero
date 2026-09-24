import { textOfToolResult, toolNamesById } from "../adapters/adapter.js";
import { stripOptionalNulls, toOpenAIStrictSchema } from "../schema.js";
import type { AssistantContentBlock, EnvelopeVia, Message, ToolDef, ToolUseBlock } from "../types.js";
import type { CliImage } from "./provider.js";

/**
 * Turn envelope protocol, version 1 (docs/CLI-PROVIDERS.md §3.2, frozen). In completion mode a CLI is a stateless
 * model endpoint: the request history is rendered into a fenced transcript, every built-in tool is off, and the model
 * answers with exactly one envelope `{text, tool_calls[]}`. Our orchestrator runs the calls, as it does for an API
 * model. Everything here is pure.
 */

export const CLI_TURN_PROTOCOL = 1;
export const MAX_ENVELOPE_BYTES = 256 * 1024;
export const MAX_ENVELOPE_CALLS = 16;

/** Everything the model says in one assistant turn. `tool_calls: []` means a final answer. */
export interface TurnEnvelope {
  /** "" when there is nothing to say. */
  text: string;
  tool_calls: Array<{ name: string; arguments: Record<string, unknown> }>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ------------------------------------------------------------------------------------------------ schema

/**
 * JSON Schema of the envelope for `tools`: exactly `text` and `tool_calls`; each call is an `anyOf` with one branch
 * per tool (`name` pinned by an enum, `arguments` = that tool's input schema). `openai-strict` passes every tool
 * schema through {@link toOpenAIStrictSchema} (Codex `--output-schema` is strict).
 */
export function envelopeSchema(tools: readonly ToolDef[], style: "plain" | "openai-strict", options: { maxCalls?: number } = {}): Record<string, unknown> {
  const maxCalls = Math.max(0, Math.min(options.maxCalls ?? MAX_ENVELOPE_CALLS, MAX_ENVELOPE_CALLS));
  const branches = tools.map((t) => ({
    type: "object",
    properties: {
      name: { type: "string", enum: [t.name] },
      arguments: style === "openai-strict" ? toOpenAIStrictSchema(t.name, t.inputSchema) : t.inputSchema,
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  }));
  const items: Record<string, unknown> = branches.length === 1 ? (branches[0] as Record<string, unknown>) : { anyOf: branches };
  return {
    type: "object",
    properties: {
      text: { type: "string", description: "What you say to the user in this turn; empty string when nothing." },
      tool_calls: {
        type: "array",
        description: "Tool calls to run now, in order. Empty array when the answer is final.",
        items: branches.length === 0 ? { type: "object", additionalProperties: false, properties: {}, required: [] } : items,
        maxItems: branches.length === 0 ? 0 : maxCalls,
      },
    },
    required: ["text", "tool_calls"],
    additionalProperties: false,
  };
}

/** The `submit_turn` tool of the `submit` MCP scope: its input is the envelope. */
export function submitTurnToolDef(schema: Record<string, unknown>): ToolDef {
  return {
    name: "submit_turn",
    description: "Submit your whole turn: the text for the user and the tool calls to run. Call it exactly once, then end your turn.",
    inputSchema: schema,
    readOnly: true,
  };
}

// ------------------------------------------------------------------------------------------------ system appendix

export const ENVELOPE_APPENDIX_VERSION = "aicad-envelope-v1";

/** Fixed, versioned text appended to the system prompt in completion mode (§3.2.4). */
export function envelopeAppendix(tools: readonly ToolDef[], via: EnvelopeVia): string {
  const lines: string[] = [
    `# Reply protocol (${ENVELOPE_APPENDIX_VERSION})`,
    "",
    "You have no tools of your own: no shell, no files, no web access. You act only by asking the application to run its tools, listed below. The application runs them and sends their results back in the next message, in tool-result blocks of the transcript.",
    "",
    'Reply with exactly one turn envelope: a JSON object {"text": string, "tool_calls": [{"name": string, "arguments": object}]}.',
    '- "text": what you say to the user in this turn ("" when there is nothing to say).',
    '- "tool_calls": the tool calls to run now, in order; [] when your answer is final. The arguments must match the tool\'s input schema.',
    "",
  ];
  if (via === "json-schema") {
    lines.push("The envelope is enforced as your structured output: return it through the structured output mechanism and nothing else.");
  } else if (via === "mcp-submit") {
    lines.push(
      "Deliver the envelope by calling the `submit_turn` tool exactly once, with the envelope as its input (your CLI may show it with a server prefix, such as mcp_cad_submit_turn or cad_submit_turn). If it answers with an error, fix the envelope and call it again. After it is recorded, end your turn with one short line.",
    );
  } else {
    lines.push("Your whole reply must be that one JSON object, optionally inside a single ```json fence, with nothing before or after it.");
  }
  lines.push("", "# Application tools", "");
  for (const t of tools) {
    lines.push(`## ${t.name}`, t.description.trim());
    if (via !== "json-schema") lines.push(`Input schema: ${JSON.stringify(t.inputSchema)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Appended to the system prompt when there are no tools: the model answers in plain text. */
export const PLAIN_REPLY_APPENDIX =
  "# Reply protocol\n\nYou have no tools: no shell, no files, no web access. The conversation so far is given as a transcript in the user message. Reply with the next assistant turn as plain text only.";

/** The one repair note of the `text-json` channel (§3.2.3). */
export function envelopeRepairNote(error: string): string {
  return `Your previous reply was not one valid JSON object in the required format (${error}). Reply with only that JSON object.`;
}

// ------------------------------------------------------------------------------------------------ transcript

/**
 * (additive) The image media types a CLI image channel accepts, each with a FIXED file extension. `mediaType` is only a
 * TypeScript type on the way in; it becomes part of workspace file names and, for Gemini, of the `-p` argv as an
 * `@<name>` reference, so it is checked at runtime and never used as text.
 */
export const CLI_IMAGE_EXTENSIONS: Readonly<Record<CliImage["mediaType"], string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function isCliImageMediaType(v: unknown): v is CliImage["mediaType"] {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CLI_IMAGE_EXTENSIONS, v);
}

/** `img-<n>.<ext>` for the n-th image (1-based), the extension from the fixed map. Throws on any other media type. */
export function cliImageFileName(n: number, mediaType: unknown): string {
  if (!isCliImageMediaType(mediaType)) throw new Error("unsupported image media type");
  return `img-${Math.max(1, Math.floor(n))}.${CLI_IMAGE_EXTENSIONS[mediaType]}`;
}

function attr(value: string): string {
  return value.replace(/[^\w.:@/-]/g, "_").slice(0, 128);
}

/** Content cannot forge a closing tag it does not know; make sure it cannot contain the one it could guess. */
function unfence(text: string, fence: string): string {
  if (!text.includes(fence)) return text;
  return text.split(fence).join(`${fence.slice(0, 4)}\u200b${fence.slice(4)}`);
}

/**
 * Render the request history deterministically (§3.2.4). `fence` is 8 random hex characters per invocation. Images
 * go to the returned list when the provider has an image channel; otherwise they become `[image omitted]`.
 */
export function renderTranscript(
  messages: readonly Message[],
  fence: string,
  options: { images: boolean },
): { text: string; images: CliImage[]; warnings: string[] } {
  const out: string[] = [`<transcript-${fence}>`];
  const images: CliImage[] = [];
  const warnings: string[] = [];
  let omitted = 0;
  let badType = 0;
  const names = toolNamesById(messages);
  const image = (block: { source: { type: string; mediaType?: string; data?: string; url?: string } }): string => {
    if (options.images && block.source.type === "base64" && typeof block.source.data === "string") {
      const mediaType: unknown = block.source.mediaType;
      if (isCliImageMediaType(mediaType)) {
        images.push({ mediaType, data: block.source.data });
        return `[image ${images.length}]`;
      }
      badType += 1;
      return "[image omitted]";
    }
    omitted += 1;
    return "[image omitted]";
  };
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const calls = m.content.filter((b): b is ToolUseBlock => b.type === "tool_use").map((b) => ({ name: b.name, arguments: b.input }));
      out.push(`<assistant-${fence}>`, unfence(JSON.stringify({ text, tool_calls: calls }), fence), `</assistant-${fence}>`);
      continue;
    }
    let userParts: string[] = [];
    const flushUser = (): void => {
      if (userParts.length === 0) return;
      out.push(`<user-${fence}>`, unfence(userParts.join("\n"), fence), `</user-${fence}>`);
      userParts = [];
    };
    for (const b of m.content) {
      if (b.type === "text") userParts.push(b.text);
      else if (b.type === "image") userParts.push(image(b));
      else {
        flushUser();
        const name = b.toolName ?? names.get(b.toolUseId) ?? "unknown";
        let body: string;
        if (typeof b.content === "string") body = b.content;
        else {
          body = b.content.map((c) => (c.type === "text" ? c.text : image(c))).join("\n");
          if (body.length === 0) body = textOfToolResult(b.content);
        }
        out.push(
          `<tool-result-${fence} call="${attr(b.toolUseId)}" name="${attr(name)}" error="${b.isError === true ? "true" : "false"}">`,
          unfence(body, fence),
          `</tool-result-${fence}>`,
        );
      }
    }
    flushUser();
  }
  out.push(`</transcript-${fence}>`, "Write the next assistant turn.");
  if (omitted > 0) warnings.push(`${omitted} image(s) omitted: this CLI provider has no image channel`);
  if (badType > 0) warnings.push(`${badType} image(s) omitted: only PNG, JPEG, WebP and GIF images are sent to CLI providers`);
  return { text: out.join("\n"), images, warnings };
}

// ------------------------------------------------------------------------------------------------ extraction

type Extracted = { ok: true; envelope: TurnEnvelope } | { ok: false; error: string };

/**
 * Strict validation (§3.2.3): a plain object with exactly `text: string` and `tool_calls: array`, at most 256 KiB
 * and 16 calls, each call exactly `{name: string, arguments: object}`. Strings are parsed as JSON first; for
 * `source: "text"` one surrounding ```json fence is allowed. Argument schemas are NOT validated here (the tool
 * registry does that and answers with actionable errors).
 */
export function extractEnvelope(raw: unknown, source: "structured" | "submit_turn" | "text"): Extracted {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_ENVELOPE_BYTES) return { ok: false, error: `reply is larger than ${MAX_ENVELOPE_BYTES} bytes` };
    let s = raw.trim();
    if (source === "text" || source === "structured") {
      const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(s);
      if (fenced?.[1] !== undefined) s = fenced[1].trim();
    }
    if (s.length === 0) return { ok: false, error: "empty reply" };
    try {
      value = JSON.parse(s);
    } catch (e) {
      return { ok: false, error: `not valid JSON: ${(e as Error).message.slice(0, 160)}` };
    }
  }
  if (!isPlainObject(value)) return { ok: false, error: "not a JSON object" };
  let size: number;
  try {
    size = JSON.stringify(value).length;
  } catch {
    return { ok: false, error: "not serializable" };
  }
  if (size > MAX_ENVELOPE_BYTES) return { ok: false, error: `envelope is larger than ${MAX_ENVELOPE_BYTES} bytes` };
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "text" || keys[1] !== "tool_calls") {
    return { ok: false, error: `the object must have exactly the keys "text" and "tool_calls" (found: ${keys.slice(0, 8).join(", ") || "none"})` };
  }
  const text = value["text"];
  const calls = value["tool_calls"];
  if (typeof text !== "string") return { ok: false, error: '"text" must be a string' };
  if (!Array.isArray(calls)) return { ok: false, error: '"tool_calls" must be an array' };
  if (calls.length > MAX_ENVELOPE_CALLS) return { ok: false, error: `at most ${MAX_ENVELOPE_CALLS} tool calls per turn` };
  const out: TurnEnvelope["tool_calls"] = [];
  for (const [i, c] of calls.entries()) {
    if (!isPlainObject(c)) return { ok: false, error: `tool_calls[${i}] must be an object` };
    const ck = Object.keys(c).sort();
    if (ck.length !== 2 || ck[0] !== "arguments" || ck[1] !== "name") return { ok: false, error: `tool_calls[${i}] must have exactly "name" and "arguments"` };
    const name = c["name"];
    const args = c["arguments"];
    if (typeof name !== "string" || name.length === 0 || name.length > 128) return { ok: false, error: `tool_calls[${i}].name must be a tool name` };
    if (!isPlainObject(args)) return { ok: false, error: `tool_calls[${i}].arguments must be an object` };
    out.push({ name, arguments: args });
  }
  return { ok: true, envelope: { text, tool_calls: out } };
}

/**
 * Map an envelope to assistant content. Ids are `cli_<prefix>_<turn>_<k>` (prefix: 8 hex per invocation). A name not
 * in `tools` keeps `inputError: "unknown tool <name>"` so it is answered with an error, never run. Nulls for optional
 * properties (OpenAI strict style) are stripped so inputs look the same on every provider.
 */
export function envelopeToContent(env: TurnEnvelope, tools: readonly ToolDef[], idPrefix: string, turn: number): AssistantContentBlock[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const content: AssistantContentBlock[] = [];
  if (env.text.length > 0) content.push({ type: "text", text: env.text });
  env.tool_calls.forEach((c, k) => {
    const tool = byName.get(c.name);
    const input = tool === undefined ? c.arguments : (stripOptionalNulls(c.arguments, tool.inputSchema) as Record<string, unknown>);
    const block: ToolUseBlock = { type: "tool_use", id: `cli_${idPrefix}_${turn}_${k}`, name: c.name, input };
    if (tool === undefined) block.inputError = `unknown tool ${c.name}`;
    content.push(block);
  });
  return content;
}

/**
 * Gemini only (§4.3): Gemini 0.49 expands `@path` ANYWHERE in the headless prompt (its `@` parser is a plain regex
 * over the whole query; code fences are not special), reads the file into the request, and aborts the run when the
 * read fails. CadScript contains `@aicad/std`. A zero-width joiner after EVERY `@` (fences included) stops the
 * expansion; {@link restoreAtPaths} undoes it in what the model sends back. Idempotent.
 */
export function neutralizeAtPaths(text: string): string {
  return text.replace(/@(?=[^\s@\u200d])/g, "@\u200d");
}

/**
 * Undo {@link neutralizeAtPaths} in a value the model echoes back (envelope text and tool arguments, or runtime MCP
 * tool arguments): `@` + U+200D -> `@`, deep, strings only.
 */
export function restoreAtPaths<T>(value: T): T {
  if (typeof value === "string") return value.replace(/@\u200d/g, "@") as T;
  if (Array.isArray(value)) return value.map((v) => restoreAtPaths(v)) as T;
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreAtPaths(v)])) as T;
  return value;
}

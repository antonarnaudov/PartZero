/**
 * A typed tool registry. Each tool has a zod input schema; the registry derives one **strict**
 * JSON Schema per tool (every object closed with `additionalProperties: false`, constraint keywords
 * that strict modes reject restated in the description and enforced by zod instead), validates
 * inputs before running a handler, and turns every failure into an `isError` result the model can
 * act on. Tool definitions are sorted by name so the prompt-cache prefix is byte-stable.
 */
import { z } from "zod";
import { stripOptionalNulls, type ToolDef } from "@aicad/llm-gateway";
import { clip } from "./format.js";

/** Structured side data for the orchestrator (never shown to the model). */
export type ToolData = { kind: string } & Record<string, unknown>;

export interface ToolOutput {
  /** What the model sees (kept under ~2k tokens by the registry). */
  text: string;
  isError?: boolean;
  data?: ToolData;
}

export interface AgentTool<Ctx, S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  /** True for tools that never change the design (safe in ask/explain mode). */
  readOnly?: boolean;
  run(input: z.output<S>, ctx: Ctx): Promise<ToolOutput> | ToolOutput;
}

/** Identity helper that keeps the input type of `run` tied to the schema. */
export function defineTool<Ctx, S extends z.ZodObject>(tool: AgentTool<Ctx, S>): AgentTool<Ctx, S> {
  return tool;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keywords some strict modes reject (Anthropic structured outputs, Gemini). zod still enforces them. */
const CONSTRAINT_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems"];

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!isObject(node)) return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema" || k === "default") continue;
    if (k === "properties" && isObject(v)) out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictify(pv)]));
    else if (k === "$defs" && isObject(v)) out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictify(pv)]));
    else out[k] = strictify(v);
  }
  // zod's int() adds the safe-integer range: noise for a model, drop it silently.
  if (out["minimum"] === Number.MIN_SAFE_INTEGER) delete out["minimum"];
  if (out["maximum"] === Number.MAX_SAFE_INTEGER) delete out["maximum"];
  const dropped = CONSTRAINT_KEYWORDS.filter((k) => k in out);
  if (dropped.length > 0) {
    const note = `(${dropped.map((k) => `${k}: ${JSON.stringify(out[k])}`).join(", ")})`;
    for (const k of dropped) delete out[k];
    out["description"] = typeof out["description"] === "string" && out["description"].length > 0 ? `${out["description"]} ${note}` : note;
  }
  // `type: ["string", "number"]` (zod's primitive unions) → anyOf: understood the same way by every provider.
  const t = out["type"];
  if (Array.isArray(t) && t.filter((x) => x !== "null").length > 1) {
    delete out["type"];
    out["anyOf"] = t.map((x) => ({ type: x }));
  }
  const isObj = out["type"] === "object" || isObject(out["properties"]);
  if (isObj) {
    out["type"] = "object";
    out["properties"] ??= {};
    out["additionalProperties"] = false;
    out["required"] ??= [];
  }
  return out;
}

/** zod → strict JSON Schema (deterministic: same schema, same bytes). */
export function toStrictJsonSchema(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12", unrepresentable: "throw" });
  return strictify(raw) as Json;
}

/**
 * Arguments named `*_json` carry JSON as text (strict schemas close every object, so a free-form
 * object cannot pass through them). A model that sends the object itself instead of its text means
 * the same thing: it is turned into its JSON text rather than refused.
 */
function coerceJsonText(value: unknown, schema: Json | undefined): unknown {
  if (!isObject(value)) return value;
  const input = value;
  const props = isObject(schema?.["properties"]) ? (schema!["properties"] as Json) : {};
  let out: Json | null = null;
  for (const [k, v] of Object.entries(input)) {
    if (!k.endsWith("_json") || typeof v !== "object" || v === null) continue;
    const p = props[k];
    if (!isObject(p) || (p["type"] !== "string" && !Array.isArray(p["anyOf"]))) continue;
    out ??= { ...input };
    out[k] = JSON.stringify(v);
  }
  return out ?? input;
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(input)"}: ${i.message}`)
    .join("; ");
}

export interface ToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the provider could not parse the arguments (truncated/malformed JSON). */
  inputError?: string;
  rawInput?: string;
}

export class ToolRegistry<Ctx> {
  readonly #tools: Map<string, AgentTool<Ctx>>;
  readonly #schemas = new Map<string, Json>();

  constructor(tools: readonly AgentTool<Ctx, z.ZodObject>[]) {
    this.#tools = new Map();
    for (const t of tools) {
      if (this.#tools.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.name)) throw new Error(`tool name ${t.name} must be snake_case`);
      this.#tools.set(t.name, t as unknown as AgentTool<Ctx>);
      this.#schemas.set(t.name, toStrictJsonSchema(t.input));
    }
  }

  /** Tool names, sorted. */
  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): AgentTool<Ctx> | undefined {
    return this.#tools.get(name);
  }

  /** A registry with only these tools (unknown names throw). */
  subset(names: readonly string[]): ToolRegistry<Ctx> {
    return new ToolRegistry(
      names.map((n) => {
        const t = this.#tools.get(n);
        if (!t) throw new Error(`unknown tool ${n}`);
        return t;
      }),
    );
  }

  /** The strict JSON Schema of one tool's input. */
  schema(name: string): Json {
    const s = this.#schemas.get(name);
    if (!s) throw new Error(`unknown tool ${name}`);
    return s;
  }

  /** Gateway tool definitions: strict, sorted by name (stable cache prefix). */
  defs(): ToolDef[] {
    return this.names().map((name) => ({ name, description: this.#tools.get(name)!.description, inputSchema: this.#schemas.get(name)!, strict: true }));
  }

  /** Validate and run one call. Never throws: failures become `isError` results with a way forward. */
  async execute(call: ToolCall, ctx: Ctx): Promise<ToolOutput> {
    const tool = this.#tools.get(call.name);
    if (!tool) return { text: `Unknown tool "${call.name}". Available: ${this.names().join(", ")}.`, isError: true, data: { kind: "unknown_tool" } };
    if (call.inputError !== undefined) {
      const raw = call.rawInput ?? "";
      return {
        text: `The arguments for ${call.name} could not be parsed (${call.inputError}); nothing was executed. Resend a complete, valid JSON object${raw.length > 0 ? ` (received ${raw.length} chars${raw.length > 200 ? ", possibly truncated — send smaller patches" : ""})` : ""}.`,
        isError: true,
        data: { kind: "bad_input" },
      };
    }
    // OpenAI strict mode sends null for optional fields; map them back to "absent".
    const input = coerceJsonText(stripOptionalNulls(call.input, this.#schemas.get(call.name)), this.#schemas.get(call.name));
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) {
      return { text: `Invalid input for ${call.name}: ${zodMessage(parsed.error)}. Nothing was executed; fix the arguments and call again.`, isError: true, data: { kind: "bad_input" } };
    }
    try {
      const out = await tool.run(parsed.data, ctx);
      return { ...out, text: clip(out.text) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { text: `${call.name} failed: ${msg}`, isError: true, data: { kind: "tool_exception", message: msg } };
    }
  }
}

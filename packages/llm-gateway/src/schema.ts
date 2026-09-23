import { GatewayError } from "./errors.js";

/**
 * Tool input-schema rewriting per provider. The tool registry owns one JSON Schema per tool; each provider accepts a
 * different subset in strict mode, so the gateway rewrites it deterministically (same input -> same bytes, which keeps
 * the tools prefix of the prompt cache stable).
 */

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SUBSCHEMA_MAP_KEYS = ["properties", "$defs", "definitions", "patternProperties"] as const;
const SUBSCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
const SUBSCHEMA_KEYS = ["items", "additionalProperties", "not", "if", "then", "else"] as const;

/** Apply `fn` bottom-up to every sub-schema. `fn` receives a shallow copy it may mutate. */
function mapSchema(schema: unknown, fn: (node: Json) => Json): unknown {
  if (!isObject(schema)) return schema;
  const node: Json = { ...schema };
  for (const key of SUBSCHEMA_MAP_KEYS) {
    const m = node[key];
    if (isObject(m)) node[key] = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, mapSchema(v, fn)]));
  }
  for (const key of SUBSCHEMA_ARRAY_KEYS) {
    const a = node[key];
    if (Array.isArray(a)) node[key] = a.map((v) => mapSchema(v, fn));
  }
  for (const key of SUBSCHEMA_KEYS) {
    if (key in node && isObject(node[key])) node[key] = mapSchema(node[key], fn);
  }
  return fn(node);
}

function isObjectSchema(node: Json): boolean {
  return node["type"] === "object" || (Array.isArray(node["type"]) && node["type"].includes("object")) || isObject(node["properties"]);
}

export function assertObjectSchema(toolName: string, schema: Json): void {
  if (schema["type"] !== "object") {
    throw new GatewayError("invalid_request", `Tool '${toolName}': inputSchema must be a JSON Schema with type "object"`);
  }
}

/** Keywords Anthropic strict mode does not support (tool-use-concepts.md -> JSON Schema Limitations). */
const ANTHROPIC_STRICT_UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength"];

function describeDropped(node: Json, dropped: string[]): void {
  if (dropped.length === 0) return;
  const note = `(${dropped.map((k) => `${k}: ${JSON.stringify(node[k])}`).join(", ")})`;
  for (const k of dropped) delete node[k];
  node["description"] = typeof node["description"] === "string" && node["description"].length > 0 ? `${node["description"]} ${note}` : note;
}

/**
 * Anthropic: non-strict schemas pass through. Strict schemas need `additionalProperties: false` on every object;
 * unsupported numeric/string constraints are removed and restated in the description so the model still sees them
 * (validate them in the tool implementation).
 */
export function toAnthropicSchema(toolName: string, schema: Json, strict: boolean): Json {
  assertObjectSchema(toolName, schema);
  if (!strict) return schema;
  return mapSchema(schema, (node) => {
    if (isObjectSchema(node)) {
      if (node["additionalProperties"] !== undefined && node["additionalProperties"] !== false) {
        throw new GatewayError(
          "invalid_request",
          `Tool '${toolName}': strict tools require additionalProperties: false (Anthropic structured outputs)`,
        );
      }
      node["additionalProperties"] = false;
    }
    describeDropped(node, ANTHROPIC_STRICT_UNSUPPORTED.filter((k) => k in node));
    return node;
  }) as Json;
}

function makeNullable(prop: unknown): unknown {
  if (!isObject(prop)) return prop;
  const t = prop["type"];
  if (typeof t === "string") return t === "null" ? prop : { ...prop, type: [t, "null"] };
  if (Array.isArray(t)) return t.includes("null") ? prop : { ...prop, type: [...t, "null"] };
  if (Array.isArray(prop["anyOf"])) return { ...prop, anyOf: [...prop["anyOf"], { type: "null" }] };
  if (Array.isArray(prop["enum"])) return { ...prop, enum: [...prop["enum"], null] };
  return { anyOf: [prop, { type: "null" }] };
}

/**
 * OpenAI strict mode (function-calling.md -> Strict mode): every object has `additionalProperties: false` and lists
 * every property in `required`; originally optional properties become nullable. {@link stripOptionalNulls} maps the
 * model's `null`s back to "absent" so tool inputs look the same on every provider.
 */
export function toOpenAIStrictSchema(toolName: string, schema: Json): Json {
  assertObjectSchema(toolName, schema);
  return mapSchema(schema, (node) => {
    if (!isObjectSchema(node)) return node;
    if (node["additionalProperties"] !== undefined && node["additionalProperties"] !== false) {
      throw new GatewayError("invalid_request", `Tool '${toolName}': strict tools require additionalProperties: false (OpenAI strict mode)`);
    }
    const props = isObject(node["properties"]) ? node["properties"] : {};
    const required = new Set(Array.isArray(node["required"]) ? (node["required"] as string[]) : []);
    const names = Object.keys(props);
    node["properties"] = Object.fromEntries(names.map((n) => [n, required.has(n) ? props[n] : makeNullable(props[n])]));
    node["required"] = names;
    node["additionalProperties"] = false;
    return node;
  }) as Json;
}

/**
 * Undo the OpenAI strict nullable rewrite: drop `null` values for properties that were optional in the original
 * schema (recursively through nested objects and arrays).
 */
export function stripOptionalNulls(value: unknown, originalSchema: unknown): unknown {
  if (!isObject(originalSchema)) return value;
  if (Array.isArray(value)) {
    const items = originalSchema["items"];
    return value.map((v) => stripOptionalNulls(v, items));
  }
  if (!isObject(value)) return value;
  const props = isObject(originalSchema["properties"]) ? originalSchema["properties"] : {};
  const required = new Set(Array.isArray(originalSchema["required"]) ? (originalSchema["required"] as string[]) : []);
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null && !required.has(k) && k in props) continue;
    out[k] = stripOptionalNulls(v, props[k]);
  }
  return out;
}

/**
 * Gemini `parametersJsonSchema` accepts a documented JSON Schema subset. Unsupported keywords are dropped (restated in
 * the description when they carry constraints); `const` becomes a one-value `enum`.
 */
const GOOGLE_SUPPORTED = new Set([
  "$id",
  "$defs",
  "$ref",
  "$anchor",
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);
const GOOGLE_CONSTRAINTS_TO_DESCRIBE = ["pattern", "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];

export function toGoogleSchema(toolName: string, schema: Json): Json {
  assertObjectSchema(toolName, schema);
  return mapSchema(schema, (node) => {
    if ("const" in node && !("enum" in node)) node["enum"] = [node["const"]];
    describeDropped(node, GOOGLE_CONSTRAINTS_TO_DESCRIBE.filter((k) => k in node));
    for (const key of Object.keys(node)) if (!GOOGLE_SUPPORTED.has(key)) delete node[key];
    return node;
  }) as Json;
}

/**
 * Which parameters an IR v1 feature or parameter reads (SPEC-v1 §2.3 Scalar sites only), and who
 * reads a parameter: the edited-feature closure of the design session (warnings on features a
 * changed parameter drives must be explained) and the repair hints (a one-step `set_param` changes
 * every feature the parameter drives, so the hint names the others) share it.
 */
import { v1 as cs } from "@aicad/cadscript";
import { v1 as ir } from "@aicad/ir-types";

/** The part of a zod v4 schema definition the expression walker reads. */
interface ZodDef {
  type?: string;
  innerType?: unknown;
  getter?: () => unknown;
  in?: unknown;
  shape?: Record<string, unknown>;
  element?: unknown;
  items?: readonly unknown[];
  rest?: unknown;
  options?: readonly unknown[];
  discriminator?: string;
  valueType?: unknown;
  left?: unknown;
  right?: unknown;
  values?: readonly unknown[];
}

const zodDef = (schema: unknown): ZodDef | undefined => (schema as { _zod?: { def?: ZodDef } } | undefined)?._zod?.def;
const zodAccepts = (schema: unknown, value: unknown): boolean => (schema as { safeParse?: (v: unknown) => { success: boolean } }).safeParse?.(value).success === true;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function everyString(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const x of value) everyString(x, out);
  else if (isRecord(value)) for (const x of Object.values(value)) everyString(x, out);
}

/**
 * The expression strings of an IR v1 value, found by walking it along its zod schema: a string
 * counts only where the schema has a `Scalar` or `BoolScalar` (SPEC-v1 §2.3) — never an object key,
 * an id, a curve id, a query's feature/curve token or an enum string (`depth: "through"`). A union
 * takes the option the value matches (a discriminated union: the option its tag names). Where no
 * option matches, every string below counts: over-reporting can only make a warning block, never
 * hide one.
 */
function expressionStrings(schema: unknown, value: unknown, out: string[], depth = 0): void {
  if (value === undefined || value === null) return;
  if (schema === ir.ScalarSchema || schema === ir.BoolScalarSchema) {
    if (typeof value === "string") out.push(value);
    return;
  }
  const def = zodDef(schema);
  if (def === undefined || depth > 256) return everyString(value, out);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return expressionStrings(def.innerType, value, out, depth + 1);
    case "lazy":
      return expressionStrings(def.getter?.(), value, out, depth + 1);
    case "pipe":
      return expressionStrings(def.in, value, out, depth + 1);
    case "object":
      if (isRecord(value)) for (const [k, s] of Object.entries(def.shape ?? {})) if (k in value) expressionStrings(s, value[k], out, depth + 1);
      return;
    case "array":
      if (Array.isArray(value)) for (const x of value) expressionStrings(def.element, x, out, depth + 1);
      return;
    case "tuple":
      if (Array.isArray(value)) value.forEach((x, i) => expressionStrings(def.items?.[i] ?? def.rest, x, out, depth + 1));
      return;
    case "record":
      if (isRecord(value)) for (const x of Object.values(value)) expressionStrings(def.valueType, x, out, depth + 1);
      return;
    case "intersection":
      expressionStrings(def.left, value, out, depth + 1);
      expressionStrings(def.right, value, out, depth + 1);
      return;
    case "union": {
      let options = def.options ?? [];
      if (def.discriminator !== undefined && isRecord(value)) {
        const tag = value[def.discriminator];
        const tagged = options.filter((o) => {
          const lit = zodDef(zodDef(o)?.shape?.[def.discriminator!]);
          return lit?.values === undefined || lit.values.includes(tag);
        });
        // The tag decides the shape even when some value inside is out of range.
        if (tagged.length === 1) return expressionStrings(tagged[0], value, out, depth + 1);
        options = tagged;
      }
      const hit = options.find((o) => zodAccepts(o, value));
      return hit === undefined ? everyString(value, out) : expressionStrings(hit, value, out, depth + 1);
    }
    default:
      // Leaves (string ids, enums, literals, numbers, booleans) hold no expression.
      return;
  }
}

/** The names an expression reads (functions excluded); an unparsable text gives every identifier in it. */
function namesInExpression(text: string): string[] {
  const parsed = cs.parseExpr(text);
  if (!parsed.ok) return text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const out: string[] = [];
  const stack: cs.Expr[] = [parsed.ast];
  while (stack.length > 0) {
    const e = stack.pop()!;
    if (e.k === "name") out.push(e.name);
    else if (e.k === "call") stack.push(...e.args);
    else if (e.k === "un") stack.push(e.e);
    else if (e.k === "bin") stack.push(e.l, e.r);
    else if (e.k === "cond") stack.push(e.c, e.t, e.f);
  }
  return out;
}

/** The parameter names a feature's expressions read (its Scalar and BoolScalar fields only). */
export function featureParamNamesV1(feature: ir.Feature): Set<string> {
  const texts: string[] = [];
  expressionStrings(ir.FeatureSchema, feature, texts);
  return new Set(texts.flatMap(namesInExpression));
}

/** The parameter names a parameter's value and bounds read. */
export function paramNamesV1(p: ir.Parameter): Set<string> {
  return new Set([p.value, p.min, p.max].filter((x): x is string => typeof x === "string").flatMap(namesInExpression));
}

/** Every parameter of a document with the names its value and bounds read. */
function paramsOf(doc: ir.IrDocument): ir.Parameter[] {
  return [...(doc.params ?? []), ...doc.parts.flatMap((part) => part.params ?? [])];
}

/**
 * Who reads parameter `name`, directly or through derived parameters (`b = a * 2` reads `a`; a
 * feature reading `b` reads `a` too), bounds included: the derived parameters and the features, in
 * document order. The parameter itself is not listed.
 */
export function parameterUsersV1(doc: ir.IrDocument | null | undefined, name: string): { params: string[]; features: string[] } {
  if (!doc) return { params: [], features: [] };
  const params = paramsOf(doc);
  const reads = new Map(params.map((p) => [p.name, paramNamesV1(p)] as const));
  const reached = new Set([name]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of params) {
      if (reached.has(p.name)) continue;
      if ([...reads.get(p.name)!].some((n) => reached.has(n))) {
        reached.add(p.name);
        grew = true;
      }
    }
  }
  const features: string[] = [];
  for (const part of doc.parts) for (const f of part.features) if ([...featureParamNamesV1(f)].some((n) => reached.has(n))) features.push(f.name);
  return { params: params.map((p) => p.name).filter((n) => n !== name && reached.has(n)), features };
}

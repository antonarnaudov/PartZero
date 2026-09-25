/**
 * Text for the IR v1 report's structured data (SPEC-v1 §7): feature ids → the CadScript const
 * names the agent writes, body origins, probes, reference candidates and their queries (printed
 * back as CadScript by the real printer). Everything here reads `details`, the report and the IR;
 * nothing parses a `message`. Strings that come from the user's file (names, ids, keys) are shown
 * through {@link ident} / {@link jsonQuote}, so they can never start a prompt line of their own.
 */
import ts from "typescript";
import { v1 as cs } from "@aicad/cadscript";
import type { v1 as ir, metricsV1 } from "@aicad/ir-types";
import { ident, jsonQuote, num, oneLine, vec } from "../format.js";

export type Details = Readonly<Record<string, unknown>>;

/** What a hint or summary may look at. Every field is optional: hints degrade, never fail. */
export interface V1View {
  /** The whole report (feature ids → names, parameters, sketch `solved` geometry). */
  report?: metricsV1.EvalReport | null | undefined;
  /** The compiled IR (Ref fields, parameter declarations, feature fields). */
  ir?: ir.IrDocument | null | undefined;
}

// ─── Detail accessors (details are engine output: validate every read) ─────────────────────────

export function str(d: Details | undefined, k: string): string | undefined {
  const v = d?.[k];
  return typeof v === "string" ? v : undefined;
}

export function numberOf(d: Details | undefined, k: string): number | undefined {
  const v = d?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function list(d: Details | undefined, k: string): unknown[] {
  const v = d?.[k];
  return Array.isArray(v) ? v : [];
}

export function strings(d: Details | undefined, k: string): string[] {
  return list(d, k).filter((x): x is string => typeof x === "string");
}

export function obj(v: unknown): Details | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Details) : undefined;
}

/** A detail value as short text: numbers via {@link num}, strings as ids, others as compact JSON. */
export function valueText(v: unknown): string {
  if (typeof v === "number") return num(v);
  if (typeof v === "string") return ident(v);
  if (typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "none";
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return vec(v as number[]);
  return oneLine(JSON.stringify(v), 200);
}

// ─── Names ─────────────────────────────────────────────────────────────────────────────────────

/** Every feature of the IR (all parts). */
export function irFeatures(doc: ir.IrDocument | null | undefined): ir.Feature[] {
  return doc ? doc.parts.flatMap((p) => p.features) : [];
}

/** The CadScript name of a feature id (report first, then IR); the id itself when unknown. */
export function featureName(view: V1View, id: string): string {
  const r = view.report?.features.find((f) => f.feature_id === id);
  if (r) return r.feature;
  const f = irFeatures(view.ir).find((x) => x.id === id);
  return f ? f.name : id;
}

/** A feature by CadScript name, from the IR. */
export function irFeatureByName(doc: ir.IrDocument | null | undefined, name: string): ir.Feature | undefined {
  return irFeatures(doc).find((f) => f.name === name);
}

/** `slab (region o.bottom)` for a body origin `{ feature, member, instance? }`. */
export function originText(view: V1View, origin: unknown): string {
  const o = obj(origin);
  const feature = str(o, "feature");
  if (!o || feature === undefined) return valueText(origin);
  const member = str(o, "member");
  const inst = list(o, "instance").filter((x): x is number => typeof x === "number");
  return `the body of ${ident(featureName(view, feature))}${member ? ` (region ${ident(member)})` : ""}${inst.length > 0 ? ` instance ${vec(inst)}` : ""}`;
}

/** Display names are engine-made from the user's names: plain when simple, else JSON-quoted. */
export function displayName(name: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_./:{}|@#+-]{0,160}$/.test(name) ? name : jsonQuote(name.slice(0, 160));
}

/** `face at [x, y, z] facing [nx, ny, nz]` / `edge through [x, y, z]`. */
export function probeText(probe: unknown): string {
  const p = obj(probe);
  const point = list(p, "point").filter((x): x is number => typeof x === "number");
  const normal = list(p, "normal").filter((x): x is number => typeof x === "number");
  const kind = str(p, "kind") ?? "entity";
  if (point.length !== 3) return kind;
  const at = kind === "edge" ? "through" : "at";
  return `${kind} ${at} ${vec(point)}${normal.length === 3 ? ` ${kind === "face" ? "facing" : "normal"} ${vec(normal)}` : ""}`;
}

// ─── Queries as CadScript ──────────────────────────────────────────────────────────────────────

const PROBE_NAME = "q__render";

/**
 * A query (or a whole Ref) written as the CadScript chain the printer would write, e.g.
 * `e.side("o.bottom").max("+X")`. The printer needs the features the query names, so it prints
 * the IR with one extra `tag` feature; without an IR (or when printing fails) the query is shown
 * as compact JSON with feature ids replaced by names.
 */
export function queryText(view: V1View, query: unknown, kind: string = "face"): string {
  const q = obj(query);
  if (!q) return valueText(query);
  const doc = view.ir;
  if (doc && doc.parts.length > 0) {
    try {
      const probe = structuredClone(doc);
      // The tag goes into the part whose features the query names (queries never cross parts).
      const json = JSON.stringify(q);
      const owner = probe.parts.find((p) => p.features.some((f) => json.includes(`"${f.id}"`))) ?? probe.parts[probe.parts.length - 1]!;
      owner.features.push({ type: "tag", id: PROBE_NAME, name: PROBE_NAME, target: { kind: kind as ir.EntityKind, q: q as unknown as ir.Query } } as ir.Feature);
      const printed = cs.print(probe);
      const text = tagArgument(printed, PROBE_NAME);
      if (text !== undefined) return text;
    } catch {
      // Not printable here (e.g. a query naming a feature of another part): fall back to JSON.
    }
  }
  const named = JSON.stringify(q, (k, v: unknown) => (k === "feature" && typeof v === "string" ? featureName(view, v) : v));
  return oneLine(named, 300);
}

/** The source text of the argument of `const <name> = tag(<arg>)` in printed CadScript. */
function tagArgument(source: string, name: string): string | undefined {
  const sf = ts.createSourceFile("print.cad.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const d = stmt.declarationList.declarations[0];
    if (!d || !ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer || !ts.isCallExpression(d.initializer)) continue;
    const arg = d.initializer.arguments[0];
    return arg ? arg.getText(sf).replace(/\s*\n\s*/g, " ") : undefined;
  }
  return undefined;
}

// ─── JSON pointers into features ───────────────────────────────────────────────────────────────

function unescapePointer(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** The value at a JSON pointer (`/on/face`) inside `root`; undefined when absent. */
export function atPointer(root: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return root;
  let cur: unknown = root;
  for (const raw of pointer.replace(/^\//, "").split("/")) {
    const seg = unescapePointer(raw);
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (cur !== null && typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

/** Set the value at a JSON pointer inside `root` (the parent must exist). Returns false when it does not. */
export function setAtPointer(root: unknown, pointer: string, value: unknown): boolean {
  const segs = pointer.replace(/^\//, "").split("/").map(unescapePointer);
  const last = segs.pop();
  if (last === undefined || last === "") return false;
  const parent = atPointer(root, segs.length === 0 ? "" : `/${segs.join("/")}`);
  if (Array.isArray(parent)) {
    const i = Number(last);
    if (!Number.isInteger(i) || i < 0 || i >= parent.length) return false;
    parent[i] = value;
    return true;
  }
  if (parent === null || typeof parent !== "object") return false;
  (parent as Record<string, unknown>)[last] = value;
  return true;
}

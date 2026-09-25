/**
 * Read-only tools of the op agent: finding faces, edges and bodies by **semantic references**
 * (IR v1 queries, SPEC-v1 §5.3) on the live document, measuring it, and checking it with Forge
 * (FULL-MODELING-PLAN §2.2 "Queries", §2.10). They never change the model.
 *
 * - `find_entities`: what a Ref / query matches at a point of the timeline (count, names, probes),
 *   so a fillet's `edges` or a hole's `on.face` is aimed before it is written.
 * - `list_entities`: the faces, edges or vertices of the model (or of one feature), filtered by
 *   name or nearest to a point, each with a ready-made **named query** that the engine verified
 *   resolves to exactly that entity.
 * - `measure`: every feature's result and the final bodies, or one feature in detail.
 * - `check_model`: the Forge verification of the whole model (statuses, warnings, validity).
 *
 * Queries are evaluated by appending `tag` features (SPEC-v1 §6.12) to a scratch copy of the
 * document — the engine resolves them exactly as it resolves a feature's reference at that
 * position — and reading their `refs` from the report. The scratch copy is never stored.
 */
import type { metricsV1 } from "@aicad/ir-types";
import { CommandEngineError, parseDoc, type DocJson, type OpsHost } from "@aicad/model-ops";
import { z } from "zod";
import { capList, clip, dims, num, oneLine, plural, vec } from "./format.js";
import { opsRepairHint } from "./ops-playbooks.js";
import { defineTool, type AgentTool, type ToolOutput } from "./registry.js";
import { bboxSize } from "./summaries.js";
import { displayName, probeText } from "./v1/render.js";
import { featureResultTextV1, measureTextV1, modelTotalsV1, totalsTextV1 } from "./v1/summaries.js";

/** What the read-only op tools run against (the op tools' context). */
export interface OpsQueryContext {
  ops: OpsHost;
}

type Kind = "face" | "edge" | "vertex" | "body";
const KINDS = ["face", "edge", "vertex", "body"] as const;
const PROBE_PREFIX = "zz_probe";

export interface ProbeQuery {
  kind: Kind;
  q: unknown;
}

export type ProbeResult = { ok: true; members: metricsV1.RefMember[][]; report: metricsV1.EvalReport } | { ok: false; code: string; text: string };

/**
 * Resolve `queries` in one evaluation: each becomes a `tag` feature (card `any`) inserted after
 * `after` (a feature id or name; default the end of the part), so it sees the model as a feature
 * there would. Returns each query's members in canonical order, or the rejection.
 */
export async function probeQueries(ops: OpsHost, queries: readonly ProbeQuery[], at: { part?: string | undefined; after?: string | undefined } = {}): Promise<ProbeResult> {
  const doc = parseDoc(await ops.document());
  const partIndex = at.part === undefined ? 0 : doc.parts.findIndex((p) => p.id === at.part || p.name === at.part);
  const part = doc.parts[partIndex];
  if (!part) return { ok: false, code: "COMMAND_UNKNOWN_PART", text: `There is no part ${JSON.stringify(at.part)}; parts: ${doc.parts.map((p) => p.id).join(", ")}.` };
  let index = part.features.length;
  if (at.after !== undefined) {
    const i = part.features.findIndex((f) => f.id === at.after || f.name === at.after);
    if (i < 0) return { ok: false, code: "COMMAND_UNKNOWN_FEATURE", text: `There is no feature ${JSON.stringify(at.after)} in part ${part.id} (get_model lists them).` };
    index = i + 1;
  }
  const taken = new Set(doc.parts.flatMap((p) => p.features.flatMap((f) => [f.id, f.name])));
  let n = 0;
  const ids = queries.map(() => {
    let id: string;
    do id = `${PROBE_PREFIX}${++n}`;
    while (taken.has(id));
    return id;
  });
  const tags = queries.map((q, i) => ({ type: "tag", id: ids[i]!, name: ids[i]!, target: { kind: q.kind, q: q.q, card: "any" } }));
  part.features.splice(index, 0, ...(tags as unknown as DocJson["parts"][number]["features"]));
  let report: metricsV1.EvalReport;
  try {
    report = await ops.engine().report(JSON.stringify(doc));
  } catch (e) {
    const err = e instanceof CommandEngineError ? e : null;
    return { ok: false, code: err?.code ?? "ENGINE_FAILED", text: `The engine could not evaluate the query: ${oneLine(e instanceof Error ? e.message : String(e), 400)}` };
  }
  if (report.error) {
    type Problem = { code: string; path?: string; message?: string };
    const listed = (report.error.details as Record<string, unknown> | undefined)?.["errors"] as Problem[] | undefined;
    const problems: Problem[] = (listed ?? [{ code: report.error.code, message: report.error.message }]).slice(0, 4);
    const lines = problems.map((p) => `  ✗ ${p.code}${p.path ? ` at ${tagPath(p.path)}` : ""}: ${oneLine(p.message ?? "", 300)}`);
    const hints = opsRepairHint({ code: report.error.code, errors: problems });
    return { ok: false, code: report.error.code, text: `The query is not valid:\n${lines.join("\n")}\nfix: ${hints.join(" ")}` };
  }
  const members: metricsV1.RefMember[][] = [];
  for (const id of ids) {
    const entry = report.features.find((f) => f.feature_id === id);
    if (!entry) return { ok: false, code: "QUERY_NOT_EVALUATED", text: "The query was not evaluated: a feature before it fails or is suppressed (check_model shows which). Fix the model first, or pass after: an earlier feature." };
    if (entry.status === "error") {
      const code = entry.error?.code ?? "FAILED";
      return { ok: false, code, text: `The query fails at that point: ${code}: ${oneLine(entry.error?.message ?? "", 300)}\nfix: ${opsRepairHint({ code, ...(entry.error?.details ? { details: entry.error.details as Record<string, unknown> } : {}) }).join(" ")}` };
    }
    members.push(entry.refs?.[0]?.members ?? []);
  }
  return { ok: true, members, report };
}

/** A rejection path into a probe tag, as the agent wrote it (`/parts/0/features/5/target/q/where` → `q/where`). */
function tagPath(path: string): string {
  const m = /\/target\/(.*)$/.exec(path);
  return m ? `${m[1] ? `/${m[1]}` : "(the query)"}` : path;
}

// ─── Named queries from keys (SPEC-v1 §5.2) ───────────────────────────────────────────────────

function unescapeKey(s: string): string {
  return s.replace(/%([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Split `F/role:rest` (the first `/` separates the feature id; ids never contain `/`). */
function splitKey(key: string): { feature: string; role: string; rest: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0) return null;
  const feature = unescapeKey(key.slice(0, slash));
  const body = key.slice(slash + 1);
  const colon = body.indexOf(":");
  const at = body.indexOf("@");
  if (colon < 0 && at < 0) return null;
  if (colon >= 0 && (at < 0 || colon < at)) return { feature, role: body.slice(0, colon), rest: body.slice(colon + 1) };
  return { feature, role: body.slice(0, at), rest: body.slice(at) };
}

/** The face query a face key names, when it is a named source (cap, endcap, side, hole face). */
export function faceQueryOfKey(key: string): Record<string, unknown> | null {
  const k = splitKey(key);
  if (!k) return null;
  if (k.role === "cap" || k.role === "endcap") {
    const m = /^(start|end)(?:@(.+))?$/.exec(k.rest);
    if (!m) return null;
    return { op: k.role, feature: k.feature, end: m[1] };
  }
  if (k.role === "side") return { op: "side", feature: k.feature, curve: unescapeKey(k.rest) };
  const hole = /^@(.+)$/.exec(k.rest);
  if (hole && ["wall", "tip", "floor", "cbore_wall", "cbore_floor", "csink"].includes(k.role)) return { op: "hole_face", feature: k.feature, at: unescapeKey(hole[1]!), part: k.role };
  return null;
}

/** The members of a `cap` key's body (`e1/cap:end@outline.bottom` → `outline.bottom`), for disambiguation. */
function capMember(key: string): string | null {
  const k = splitKey(key);
  const m = k && (k.role === "cap" || k.role === "endcap") ? /^(?:start|end)@(.+)$/.exec(k.rest) : null;
  return m ? unescapeKey(m[1]!) : null;
}

/** Split `{A|B}` at the top-level `|` (keys inside braces may nest their own braces). */
function splitPair(s: string): [string, string] | null {
  if (!s.startsWith("{")) return null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "|" && depth === 1) {
      const close = s.lastIndexOf("}");
      return [s.slice(1, i), s.slice(i + 1, close)];
    }
  }
  return null;
}

/**
 * Candidate named queries for an entity key, best first: a face's source (plus the cap's member
 * when needed); an edge's `edge_at` (a sweep's junction edge) and `between` of its two faces; a
 * body's `body`. The caller verifies them (each must resolve to exactly the entity).
 */
export function namedQueriesOfKey(kind: Kind, key: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (kind === "face") {
    const q = faceQueryOfKey(key);
    if (q) {
      out.push(q);
      const member = capMember(key);
      if (member) out.push({ ...q, member });
    }
  } else if (kind === "edge") {
    const k = splitKey(key);
    if (k && k.role === "edge") {
      const qual = /@([^{}|@]+)\.(start|end)$/.exec(k.rest);
      const pairText = qual ? k.rest.slice(0, k.rest.length - qual[0].length) : k.rest;
      if (qual) out.push({ op: "edge_at", feature: k.feature, curve: unescapeKey(qual[1]!), end: qual[2] });
      const pair = splitPair(pairText);
      if (pair) {
        const a = faceQueryOfKey(pair[0]);
        const b = faceQueryOfKey(pair[1]);
        if (a && b) out.push({ op: "between", a, b });
      }
    }
  } else if (kind === "body") {
    const m = /^([^/]+)\/body:([^@]+)(?:@.*)?$/.exec(key);
    if (m) {
      out.push({ op: "body", feature: unescapeKey(m[1]!) });
      out.push({ op: "body", feature: unescapeKey(m[1]!), member: unescapeKey(m[2]!) });
    }
  }
  return out;
}

// ─── Text ─────────────────────────────────────────────────────────────────────────────────────

function memberLine(m: metricsV1.RefMember): string {
  return `${displayName(m.name)} — ${probeText(m.probe)}`;
}

function cardText(kind: Kind, n: number): string {
  if (n === 0) return `nothing matches (card "one"/"some" would fail: REF_MISSING)`;
  if (n === 1) return `unique (card "one" fits)`;
  return `${n} ${kind === "body" ? "bodies" : `${kind}s`} (card "some" or ${n} fits; "one" would fail: REF_AMBIGUOUS)`;
}

function parseRefJson(text: string, kind: Kind | undefined): { kind: Kind; q: unknown; card?: unknown } | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return `ref_json is not valid JSON (${(e as Error).message}).`;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "ref_json must be a Ref object {\"kind\", \"q\"} or a query {\"op\", …}.";
  const o = v as Record<string, unknown>;
  if (typeof o["op"] === "string") {
    if (!kind) return 'A bare query needs kind ("face", "edge", "vertex" or "body").';
    return { kind, q: o };
  }
  const k = o["kind"];
  if (typeof k !== "string" || !(KINDS as readonly string[]).includes(k)) return 'A Ref needs kind: "face", "edge", "vertex" or "body".';
  if (typeof o["q"] !== "object" || o["q"] === null) return "A Ref needs q: the query object.";
  return { kind: k as Kind, q: o["q"], card: o["card"] };
}

// ─── Tools ────────────────────────────────────────────────────────────────────────────────────

const findEntitiesTool = defineTool<OpsQueryContext, z.ZodObject>({
  name: "find_entities",
  readOnly: true,
  description:
    'Resolve a semantic reference against the model without changing it: how many faces/edges/vertices/bodies it matches, their names and probes (position, facing). Aim every Ref here before you write it into a feature (fillet "edges", hole "on", sketch "plane"). ref_json: a Ref {"kind":"edge","q":{"op":"filter","where":{"parallel":"Z"},"of":{"op":"edges","of":{"op":"sides","feature":"extrude1"}}}} or a bare query with kind. after: evaluate right after this feature (default: the end), as a feature there would see it.',
  input: z.strictObject({
    ref_json: z.string().min(2).max(20_000).describe("A Ref object, or a bare query object (then give kind), as JSON text."),
    kind: z.enum(KINDS).optional().describe("With a bare query: what it returns."),
    after: z.string().min(1).max(200).optional().describe("A feature id or name: evaluate right after it (default: the end of the part)."),
    part: z.string().min(1).max(200).optional().describe("Part id or name (default: the first part)."),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const { ref_json, kind, after, part } = args as { ref_json: string; kind?: Kind; after?: string; part?: string };
    const ref = parseRefJson(ref_json, kind);
    if (typeof ref === "string") return { text: ref, isError: true, data: { kind: "invalid_input" } };
    const r = await probeQueries(ctx.ops, [{ kind: ref.kind, q: ref.q }], { part, after });
    if (!r.ok) return { text: r.text, isError: true, data: { kind: "query_failed", code: r.code } };
    const members = r.members[0]!;
    const lines = [`${cardText(ref.kind, members.length)}${after ? ` after ${after}` : ""}:`];
    lines.push(...capList(members, 16, (m) => `  ${memberLine(m)}`, (n) => `  … ${n} more (narrow the query)`));
    if (typeof ref.card === "number" && ref.card !== members.length) lines.push(`Its card ${ref.card} would fail: REF_CARDINALITY (found ${members.length}).`);
    if (ref.card === "one" && members.length !== 1) lines.push(`Its card "one" would fail: ${members.length === 0 ? "REF_MISSING" : "REF_AMBIGUOUS"}.`);
    return { text: clip(lines.join("\n")), data: { kind: "entities", count: members.length } };
  },
});

const listEntitiesTool = defineTool<OpsQueryContext, z.ZodObject>({
  name: "list_entities",
  readOnly: true,
  description:
    "List faces, edges, vertices or bodies of the model (or only those a feature created), optionally nearest to a point or matching a name, each with its probe and — where the engine confirms it picks exactly that entity — a ready-made named query to put in a Ref. Use it to find the face to sketch on or put holes on, or the edges to fillet.",
  input: z.strictObject({
    kind: z.enum(KINDS).describe("What to list."),
    of: z.string().min(1).max(200).optional().describe("Only what this feature (id or name) created (faces/edges/vertices: of its new faces)."),
    near: z.array(z.number()).length(3).optional().describe("[x, y, z]: the entities whose probes are nearest to it first."),
    match: z.string().min(1).max(200).optional().describe("Only names or keys containing this text (e.g. \"cap:end\", \"outline.left\")."),
    after: z.string().min(1).max(200).optional().describe("List as the model is right after this feature (default: the end)."),
    limit: z.number().int().min(1).max(40).optional().describe("At most this many (default 12)."),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const { kind, of, near, match, after, limit } = args as { kind: Kind; of?: string; near?: number[]; match?: string; after?: string; limit?: number };
    let q: Record<string, unknown>;
    if (kind === "body") q = of ? { op: "body", feature: of } : { op: "bodies" };
    else {
      const created = of ? { op: "created", feature: of } : null;
      const faces = created ?? { op: "faces", of: { op: "bodies" } };
      q = kind === "face" ? faces : { op: kind === "edge" ? "edges" : "vertices", of: created ?? { op: "bodies" } };
    }
    if (of) {
      const doc = parseDoc(await ctx.ops.document());
      const f = doc.parts.flatMap((p) => p.features).find((x) => x.id === of || x.name === of);
      if (!f) return { text: `There is no feature ${JSON.stringify(of)} (get_model lists them).`, isError: true, data: { kind: "unknown_feature" } };
      if (kind === "body") q = { op: "body", feature: f.id };
      else if (q["op"] === "created") q = { op: "created", feature: f.id };
      else q = { ...q, of: { op: "created", feature: f.id } };
    }
    const r = await probeQueries(ctx.ops, [{ kind, q }], { after });
    if (!r.ok) return { text: r.text, isError: true, data: { kind: "query_failed", code: r.code } };
    let hits = r.members[0]!;
    const total = hits.length;
    if (match) hits = hits.filter((m) => m.name.includes(match) || m.key.includes(match));
    if (near) {
      const d = (m: metricsV1.RefMember): number => Math.hypot(...m.probe.point.map((x, i) => x - near[i]!));
      hits = [...hits].sort((a, b) => d(a) - d(b));
    }
    const shown = hits.slice(0, limit ?? 12);
    // Named queries for the shown entities, verified in one evaluation: each must pick exactly it.
    const cands = shown.map((m) => namedQueriesOfKey(kind, m.key));
    const flat = cands.flatMap((list, i) => list.map((cq) => ({ i, q: cq })));
    const verified = new Map<number, Record<string, unknown>>();
    if (flat.length > 0) {
      const v = await probeQueries(ctx.ops, flat.map((c) => ({ kind, q: c.q })), { after });
      if (v.ok) {
        flat.forEach((c, j) => {
          if (verified.has(c.i)) return;
          const got = v.members[j]!;
          const want = shown[c.i]!;
          if (got.length === 1 && got[0]!.key === want.key && got[0]!.probe.point.every((x, k) => Math.abs(x - want.probe.point[k]!) < 1e-6)) verified.set(c.i, c.q);
        });
      }
    }
    const header = `${plural(total, kind === "body" ? "body" : kind, kind === "body" ? "bodies" : `${kind}s`)}${of ? ` created by ${of}` : ""}${match ? `, ${hits.length} matching ${JSON.stringify(match)}` : ""}${near ? `, nearest to ${vec(near)} first` : ""}:`;
    const lines = [header];
    shown.forEach((m, i) => {
      const nq = verified.get(i);
      const dist = near ? ` (${num(Math.hypot(...m.probe.point.map((x, k) => x - near[k]!)))} mm away)` : "";
      lines.push(`  ${memberLine(m)}${dist}`);
      if (nq) lines.push(`    ref: ${JSON.stringify({ kind, q: nq })}`);
    });
    if (hits.length > shown.length) lines.push(`  … ${hits.length - shown.length} more (narrow with of / match / near)`);
    if (shown.length > 0 && verified.size < shown.length) lines.push(`Entities without a ref line have no single named query: select them with a filter (normal / parallel / radius / extreme) and check it with find_entities.`);
    return { text: clip(lines.join("\n")), data: { kind: "entities", count: total } };
  },
});

const measureTool = defineTool<OpsQueryContext, z.ZodObject>({
  name: "measure",
  readOnly: true,
  description:
    "Measurements from Forge. Without arguments: every feature's result and the final bodies (volume, bounding box, face and edge counts). With feature (id or name): that feature in detail — its bodies (volume, area, centroid, bbox, face/edge types, validity), sketch regions and solve state, hole instances, fillet/chamfer edges, reference members.",
  input: z.strictObject({
    feature: z.string().min(1).max(200).optional().describe("A feature id or name."),
    body: z.number().int().min(0).max(1000).optional().describe("With feature: only this body index."),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const { feature, body } = args as { feature?: string; body?: number };
    const report = await ctx.ops.report();
    let name: string | undefined;
    if (feature !== undefined) {
      const f = report.features.find((x) => x.feature_id === feature || x.feature === feature);
      if (!f) return { text: `No feature ${JSON.stringify(feature)} was evaluated (get_model lists them; suppressed features are not evaluated).`, isError: true, data: { kind: "unknown_feature" } };
      name = f.feature;
    }
    return { text: measureTextV1(report, { feature: name, body }), data: { kind: "measure" } };
  },
});

// ─── Checks (Forge verification) ──────────────────────────────────────────────────────────────

export interface ModelCheck {
  ok: boolean;
  /** One line: statuses, bodies, validity, size. */
  line: string;
  /** Failing features and warning-severity warnings (of `focus` features, or all). */
  issues: string[];
  failing: Array<{ id: string; name: string; code: string }>;
  bodies: number;
  invalidBodies: number;
}

/** The Forge check of a report: every feature's status, warnings, final bodies and their validity. */
export function checkReport(report: metricsV1.EvalReport, focus?: ReadonlySet<string>): ModelCheck {
  const issues: string[] = [];
  if (report.error) {
    return { ok: false, line: `✗ the model is rejected: ${report.error.code}`, issues: [oneLine(report.error.message, 300)], failing: [], bodies: 0, invalidBodies: 0 };
  }
  const failing = report.features.filter((f) => f.status === "error").map((f) => ({ id: f.feature_id, name: f.feature, code: f.error?.code ?? "FAILED" }));
  for (const f of report.features) {
    if (f.status === "error") issues.push(`✗ ${f.feature} (${f.feature_id}, ${f.type}) fails: ${f.error?.code ?? "FAILED"}: ${oneLine(f.error?.message ?? "", 240)}`);
    if (focus && !focus.has(f.feature_id)) continue;
    for (const w of f.warnings ?? []) if (w.severity === "warning") issues.push(`⚠ ${f.feature}: ${w.code}: ${oneLine(w.message, 200)}`);
  }
  for (const p of report.params ?? []) if (p.error) issues.push(`✗ parameter ${p.name}: ${p.error.code}`);
  const bodies = (report.parts ?? []).flatMap((p) => p.bodies);
  const invalid = bodies.filter((b) => !b.valid).length;
  const okCount = report.features.length - failing.length;
  const totals = modelTotalsV1(report);
  const size = totals.bodies > 0 ? `, ${dims([0, 1, 2].map((i) => totals.bboxMax[i]! - totals.bboxMin[i]!))} mm, V ${num(totals.volume)} mm³` : "";
  const line = `${failing.length === 0 ? "✓" : "✗"} ${plural(okCount, "feature")} ok${failing.length ? `, ${failing.length} failing` : ""} · ${plural(bodies.length, "body", "bodies")}${bodies.length ? (invalid ? ` (${invalid} INVALID)` : " valid") : ""}${size}`;
  return { ok: failing.length === 0 && invalid === 0 && !report.error, line, issues, failing, bodies: bodies.length, invalidBodies: invalid };
}

const checkModelTool = defineTool<OpsQueryContext, z.ZodObject>({
  name: "check_model",
  readOnly: true,
  description: "Verify the whole model with Forge: every feature builds, no warnings you should explain, every final body a valid closed solid; the overall size and volume. Call it before you finish.",
  input: z.strictObject({}),
  async run(_args, ctx): Promise<ToolOutput> {
    const report = await ctx.ops.report();
    const c = checkReport(report);
    const lines = [c.line, ...c.issues];
    for (const part of report.parts ?? []) part.bodies.slice(0, 6).forEach((b, i) => lines.push(`  body ${i + 1}: ${dims(bboxSize(b))} mm @${vec(b.bbox_min)}, V ${num(b.volume)} mm³, ${b.faces} faces, ${b.shells} shell${b.shells === 1 ? "" : "s"}${b.valid ? "" : ", INVALID"}`));
    for (const f of report.features) if (f.status === "ok") lines.push(`  ${f.feature_id} ${f.feature} [${f.type}]: ${featureResultTextV1(f)}`);
    return { text: clip(lines.join("\n")), data: { kind: "check", ok: c.ok, failing: c.failing.length } };
  },
});

/** The read-only op tools of this module. */
export function opsQueryTools(): AgentTool<OpsQueryContext, z.ZodObject>[] {
  return [findEntitiesTool, listEntitiesTool, measureTool, checkModelTool];
}

/**
 * The step check the op tools append to every committed change: Forge's verdict on the whole model
 * after it, and the warnings of the features the change touched.
 */
export async function stepCheck(ops: OpsHost, touched: ReadonlySet<string>): Promise<ModelCheck | null> {
  try {
    return checkReport(await ops.report(), touched);
  } catch {
    return null;
  }
}

/** A total line for a report (`2 bodies, total V …`), for callers outside the tools. */
export function reportTotals(report: metricsV1.EvalReport): string {
  return totalsTextV1(modelTotalsV1(report));
}

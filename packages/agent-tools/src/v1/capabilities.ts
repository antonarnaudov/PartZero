/**
 * Which v1 operations an engine evaluates, asked of the engine itself: one small probe document
 * with one part per operation (a 20 × 20 × 5 box and the operation on it). The designer's reference
 * documents every operation of CadScript v1, but an engine may reject some (Forge answers `draft`
 * with `UNSUPPORTED_FEATURE`); told up front, the designer does not spend a failed apply — in CLI
 * runtime mode one of only six — finding out (docs/BACKLOG.md, CLI providers).
 *
 * Forge rejects a whole document that contains an operation it does not implement (a document-level
 * `UNSUPPORTED_FEATURE` / `UNSUPPORTED_FEATURE_VERSION` per feature, with its path): the probe drops
 * the parts it names and evaluates the rest again, so one rejected operation does not hide the
 * others. An operation the probe cannot classify (another error, an engine failure) is `unknown`,
 * never reported as unsupported.
 */
import { v1 as cs } from "@aicad/cadscript";
import type { v1 as ir } from "@aicad/ir-types";
import type { EngineV1, ReportV1 } from "./engine.js";

/**
 * The operations the probe asks about: CadScript builtin, the IR feature type it writes, and the
 * part's body (`$` stands for the operation's suffix: const names are unique across the file).
 * `box(cx)` is a 20 × 20 × 5 box `e$` centred at (cx, 0); the probed feature is always `f$`.
 */
export const PROBED_OPERATIONS_V1: readonly { op: string; type: string; body: string }[] = [
  { op: "revolve", type: "revolve", body: 'const s$ = sketch(XY, { o: rect({ center: [20, 0], w: 5, h: 5 }) });\nconst f$ = revolve(s$, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });\n' },
  { op: "boolean", type: "boolean", body: 'box(0)const t$ = sketch(XY, { o: rect({ center: [10, 0], w: 20, h: 20 }) });\nconst u$ = extrude(t$, { distance: 5 });\nconst f$ = boolean("join", { targets: e$, tools: u$ });\n' },
  { op: "hole", type: "hole", body: 'box(0)const f$ = hole(e$.cap("end"), { at: { a: [0, 0] }, d: 3, depth: "through" });\n' },
  { op: "fillet", type: "fillet", body: "box(0)const f$ = fillet(e$.sides().edges().parallel(Z), { r: 1 });\n" },
  { op: "chamfer", type: "chamfer", body: 'box(0)const f$ = chamfer(e$.cap("end").edges(), { d: 1 });\n' },
  { op: "shell", type: "shell", body: 'box(0)const f$ = shell(e$, { open: e$.cap("end"), thickness: 1 });\n' },
  { op: "draft", type: "draft", body: "box(0)const f$ = draft(e$.sides(), { neutral: XY, angle: 2 });\n" },
  { op: "linearPattern", type: "pattern", body: "box(0)const f$ = linearPattern(e$, { dir: X, count: 2, spacing: 30 });\n" },
  { op: "circularPattern", type: "pattern", body: "box(30)const f$ = circularPattern(e$, { axis: Z, count: 2 });\n" },
  { op: "mirror", type: "pattern", body: "box(30)const f$ = mirror(e$, { plane: YZ });\n" },
];

const IMPORT = 'import { part, sketch, extrude, revolve, boolean, XY, YZ, X, Z, rect, hole, fillet, chamfer, shell, draft, linearPattern, circularPattern, mirror } from "@aicad/std";\n';

/** The probe's CadScript: part `probe_<op>` holds the box and the operation (feature `f_<op>`). */
export function capabilityProbeSourceV1(): string {
  return (
    IMPORT +
    PROBED_OPERATIONS_V1.map((p) => {
      const body = p.body.replace(/^box\((\d+)\)/, (_m, cx: string) => `const s$ = sketch(XY, { o: rect({ center: [${cx}, 0], w: 20, h: 20 }) });\nconst e$ = extrude(s$, { distance: 5 });\n`);
      return `part("probe_${p.op}");\n${body.replaceAll("$", `_${p.op}`)}`;
    }).join("")
  );
}

export interface EngineCapabilitiesV1 {
  /** The report's engine identifier. */
  engine: string;
  /** Operations the engine evaluated. */
  evaluated: string[];
  /** Operations it answered with UNSUPPORTED_FEATURE / UNSUPPORTED_FEATURE_VERSION (with the code). */
  unsupported: { op: string; type: string; code: string }[];
  /** Operations the probe could not classify (another error). */
  unknown: string[];
}

const UNSUPPORTED = new Set(["UNSUPPORTED_FEATURE", "UNSUPPORTED_FEATURE_VERSION"]);

/** Part index of a rejection path (`/parts/4/features/2/type` → 4). */
function partIndex(path: unknown): number | undefined {
  const m = typeof path === "string" ? /^\/parts\/(\d+)(?:\/|$)/.exec(path) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * Ask `engine` which v1 operations it evaluates (at most one evaluation per rejected operation, plus
 * one). Undefined when the engine cannot answer (it failed, or rejected the probe for another reason).
 */
export async function probeEngineCapabilitiesV1(engine: EngineV1, options: { timeoutMs?: number } = {}): Promise<EngineCapabilitiesV1 | undefined> {
  const compiled = cs.compile(capabilityProbeSourceV1(), { fileName: "capabilities.cad.ts" });
  if (!compiled.ok || !compiled.ir) return undefined;
  let doc: ir.IrDocument = compiled.ir;
  const opOf = (partName: string) => PROBED_OPERATIONS_V1.find((p) => `probe_${p.op}` === partName);
  const unsupported: EngineCapabilitiesV1["unsupported"] = [];
  for (let round = 0; round <= PROBED_OPERATIONS_V1.length; round++) {
    let report: ReportV1;
    try {
      report = await engine.evaluate(doc, { name: "capabilities", ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
    } catch {
      return undefined; // the engine failed (EngineError) or is missing: nothing is known
    }
    if (report.error) {
      const errors = ((report.error.details?.["errors"] as { code?: string; path?: string }[] | undefined) ?? [{ code: report.error.code }]).map((x) => ({ code: String(x.code), index: partIndex(x.path) }));
      if (errors.length === 0 || errors.some((x) => !UNSUPPORTED.has(x.code) || x.index === undefined || doc.parts[x.index] === undefined)) return undefined;
      const drop = new Set(errors.map((x) => x.index!));
      for (const x of errors) {
        const p = opOf(doc.parts[x.index!]!.name);
        if (p && !unsupported.some((u) => u.op === p.op)) unsupported.push({ op: p.op, type: p.type, code: x.code });
      }
      doc = { ...doc, parts: doc.parts.filter((_, i) => !drop.has(i)) };
      if (doc.parts.length === 0) break;
      continue;
    }
    const evaluated: string[] = [];
    const unknown: string[] = [];
    for (const part of doc.parts) {
      const p = opOf(part.name);
      if (!p) continue;
      const f = report.features.find((x) => x.part === part.name && x.feature === `f_${p.op}`);
      const code = f?.error?.code;
      if (f?.status === "ok") evaluated.push(p.op);
      else if (code !== undefined && UNSUPPORTED.has(code)) unsupported.push({ op: p.op, type: p.type, code });
      else unknown.push(p.op);
    }
    const order = (a: string) => PROBED_OPERATIONS_V1.findIndex((p) => p.op === a);
    unsupported.sort((a, b) => order(a.op) - order(b.op));
    return { engine: report.engine, evaluated, unsupported, unknown };
  }
  return { engine: engine.kind, evaluated: [], unsupported, unknown: [] };
}

/** The designer's one-line note on what the attached engine does not evaluate (undefined: nothing to say). */
export function capabilitiesNoteV1(c: EngineCapabilitiesV1 | undefined): string | undefined {
  if (!c || c.unsupported.length === 0) return undefined;
  const names = c.unsupported.map((u) => `\`${u.op}\``).join(", ");
  return `The attached engine does not evaluate ${names} (it answers ${[...new Set(c.unsupported.map((u) => u.code))].join(" / ")}): do not use ${c.unsupported.length === 1 ? "it" : "them"}; build that geometry with the operations it has${c.evaluated.length > 0 ? ` (it evaluated ${c.evaluated.map((o) => `\`${o}\``).join(", ")}, extrude and sketches)` : ""}.`;
}

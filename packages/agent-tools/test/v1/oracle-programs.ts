/**
 * CadScript v1 programs for the v1 playbook fixtures, each targeting one catalogue code of holes,
 * fillets, chamfers, shells, drafts, patterns and reference captures (§5.7 step 3). Both engines
 * evaluate every program — the OCCT oracle (`v1-oracle-reports.json`, AICAD_RECORD_FIXTURES=oracle-v1)
 * and Forge (`v1-forge-reports.json`, forge-v1) — so the same inputs' codes and
 * details are compared across engines. The oracle also evaluates every Forge scenario
 * (`scenarios.ts`) and the conformance rejection documents.
 *
 * `patch` edits the compiled IR where CadScript has no surface for the input (a reference capture:
 * only the command layer writes one, §5.6).
 */
import type { v1 as ir } from "@aicad/ir-types";

const IMPORT =
  'import { part, sketch, line, arc, circle, point, extrude, XY, XZ, X, Y, Z, param, rect, C, tag, hole, fillet, chamfer, shell, draft, linearPattern, circularPattern } from "@aicad/std";\n';

/** A 20 × 20 × 5 box centred on the origin (top face z = 5). */
const BOX = 'part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 20 }) });\nconst e = extrude(s, { distance: 5 });\n';

/** A 20 × 20 × 5 box with 4 mm rounded vertical corners (tangent side edges). */
const ROUNDED = 'part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 20, r: 4 }) });\nconst e = extrude(s, { distance: 5 });\n';

export interface OracleProgram {
  /** The catalogue code the program is meant to make the oracle raise. */
  target: string;
  /** CadScript v1 body (after the import). */
  source: string;
  /** Edits of the compiled IR (reference captures). */
  patch?: (doc: ir.IrDocument) => void;
}

type Feature = Record<string, unknown>;

function featureOf(doc: ir.IrDocument, name: string): Feature {
  const f = doc.parts.flatMap((p) => p.features).find((x) => x.name === name);
  if (!f) throw new Error(`no feature ${name}`);
  return f as unknown as Feature;
}

/** A plane face capture (§5.6) of the box side `o.left` (x = −10) with the given geometry type. */
function sideCapture(type: string, neighbors = 0): Record<string, unknown> {
  return {
    members: [
      {
        key: "f_e/side:o.left",
        via: "named",
        geom: {
          type,
          carrier: type === "plane" ? { plane: { normal: [-1, 0, 0], offset: 10 } } : { cylinder: { axis: [0, 0, 1], point: [-10, 0, 0], radius: 10 } },
          bbox: [[-10, -10, 0], [-10, 10, 5]],
          size: 100,
          centroid: [-10, 0, 2.5],
          local: [0, 0.5, 0.5],
          body_center: [0, 0, 2.5],
          neighbors,
        },
      },
    ],
  };
}

/** The box with a 2 mm slot cut across it (splits the o.bottom and o.top sides). */
const SPLIT = `${BOX}const s2 = sketch(XY, { o: rect({ center: [0, 0], w: 2, h: 40 }) });\nconst c = extrude(s2, { distance: 5, op: "cut", targets: e });\n`;

/** The capture of side o.bottom before the cut (one named member). */
function captureBottom(doc: ir.IrDocument): void {
  (featureOf(doc, "t")["target"] as Feature)["capture"] = {
    members: [
      {
        key: "f_e/side:o.bottom",
        via: "named",
        geom: { type: "plane", carrier: { plane: { normal: [0, -1, 0], offset: 10 } }, bbox: [[-10, -10, 0], [10, -10, 5]], size: 100, centroid: [0, -10, 2.5], local: [0.5, 0, 0.5], body_center: [0, 0, 2.5], neighbors: 0 },
      },
    ],
  };
}

export const ORACLE_PROGRAMS: Readonly<Record<string, OracleProgram>> = {
  // ── Holes (§6.5) ──
  hole_point_off_face: { target: "HOLE_POINT_OFF_FACE", source: `${BOX}const h = hole(e.cap("end"), { at: { a: [0, 0], b: [17.5, 0] }, d: 3, depth: "through" });\n` },
  hole_duplicate_position: { target: "HOLE_DUPLICATE_POSITION", source: `${BOX}const h = hole(e.cap("end"), { at: { a: [0, 0], b: [0, 0] }, d: 3, depth: "through" });\n` },
  hole_up_to_missed: { target: "HOLE_UP_TO_MISSED", source: `${BOX}const h = hole(e.cap("end"), { at: { a: [0, 0] }, d: 3, depth: { upTo: e.cap("start") }, flip: true });\n` },
  hole_misses_body: { target: "HOLE_MISSES_BODY", source: `${BOX}const h = hole(XY, { at: { a: [50, 0] }, d: 3, depth: "through", targets: e });\n` },
  hole_breaks_through: { target: "HOLE_BREAKS_THROUGH", source: `${BOX}const h = hole(e.cap("end"), { at: { a: [0, 0] }, d: 3, depth: { blind: 8 } });\n` },
  // ── Fillets (§6.6) ──
  fillet_too_large: { target: "FILLET_RADIUS_TOO_LARGE", source: `${BOX}const fr = param(12);\nconst corners = fillet(e.sides().edges().parallel(Z), { r: fr });\n` },
  fillet_too_large_top: { target: "FILLET_RADIUS_TOO_LARGE", source: `${BOX}const round = fillet(e.cap("end").edges(), { r: 6 });\n` },
  fillet_smooth_edge: { target: "FILLET_EDGE_UNSUPPORTED", source: `${ROUNDED}const f = fillet(e.sides().edges().parallel(Z), { r: 1, tangentChain: false });\n` },
  // Every edge of a 5 mm plate: the 8 cap edges are limited by the 5 mm side faces, feasible maximum 2.499 (rounded down, §6.6).
  fillet_all_edges: { target: "FILLET_RADIUS_TOO_LARGE", source: `${BOX}const f = fillet(e.faces().edges(), { r: 2.5 });\n` },
  // ── Chamfers (§6.7) ──
  chamfer_too_large: { target: "CHAMFER_DISTANCE_TOO_LARGE", source: `${BOX}const bevel = chamfer(e.cap("end").edges(), { d: 6 });\n` },
  chamfer_smooth_edge: { target: "CHAMFER_EDGE_UNSUPPORTED", source: `${ROUNDED}const bevel = chamfer(e.sides().edges().parallel(Z), { d: 1, tangentChain: false });\n` },
  chamfer_side_not_adjacent: { target: "CHAMFER_SIDE_NOT_ADJACENT", source: `${BOX}const bevel = chamfer(e.cap("end").edges(), { d: 1, d2: 2, side: e.cap("start") });\n` },
  chamfer_all_edges: { target: "CHAMFER_DISTANCE_TOO_LARGE", source: `${BOX}const bevel = chamfer(e.faces().edges(), { d: 2.5 });\n` },
  // ── Shell (§6.8) ──
  shell_too_thick: { target: "SHELL_THICKNESS_TOO_LARGE", source: `${BOX}const hollow = shell(e, { open: e.cap("end"), thickness: 12 });\n` },
  shell_too_thick_param: { target: "SHELL_THICKNESS_TOO_LARGE", source: `${BOX}const wall = param(12);\nconst hollow = shell(e, { open: e.cap("end"), thickness: wall });\n` },
  shell_face_not_on_body: {
    target: "SHELL_FACE_NOT_ON_BODY",
    source: `${BOX}const s2 = sketch(XY, { o: rect({ center: [40, 0], w: 10, h: 10 }) });\nconst e2 = extrude(s2, { distance: 5 });\nconst hollow = shell(e, { open: e2.cap("end"), thickness: 1 });\n`,
  },
  shell_closed_void: { target: "SHELL_CLOSED_VOID", source: `${BOX}const hollow = shell(e, { thickness: 1 });\n` },
  // ── Draft (§6.9) ──
  draft_cylinder: { target: "DRAFT_FACE_UNSUPPORTED", source: 'part("p");\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: 10 }) });\nconst e = extrude(s, { distance: 5 });\nconst dr = draft(e.sides(), { neutral: XY, angle: 2 });\n' },
  // 30° on a 20 × 20 × 50 post: the drafted sides meet below the top.
  draft_too_steep: { target: "DRAFT_FAILED", source: 'part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 20 }) });\nconst e = extrude(s, { distance: 50 });\nconst dr = draft(e.sides(), { neutral: XY, angle: 30 });\n' },
  // ── Patterns (§6.10) ──
  pattern_all_failed: {
    target: "PATTERN_ALL_INSTANCES_FAILED",
    source: `${BOX}const h = hole(e.cap("end"), { at: { a: [0, 0] }, d: 3, depth: "through" });\nconst row = linearPattern([h], { dir: Z, count: 3, spacing: 40 });\n`,
  },
  pattern_instance_skipped: {
    target: "PATTERN_INSTANCE_SKIPPED",
    source: `${BOX}const h = hole(e.cap("end"), { at: { a: [-8, 0] }, d: 3, depth: "through" });\nconst row = linearPattern([h], { dir: X, count: 4, spacing: 8 });\n`,
  },
  // ── Reference captures (§5.6, §5.7 step 3) ──
  ref_kind_changed: {
    target: "REF_KIND_CHANGED",
    source: `${BOX}const t = tag(e.side("o.left"));\n`,
    patch: (doc) => {
      (featureOf(doc, "t")["target"] as Feature)["capture"] = sideCapture("cylinder");
    },
  },
  // The cut splits side o.bottom in two: `.one()` fails with REF_SPLIT, the default count takes both pieces.
  ref_split: { target: "REF_SPLIT", source: `${SPLIT}const t = tag(e.side("o.bottom").one());\n`, patch: (doc) => captureBottom(doc) },
  ref_split_accepted: { target: "REF_SPLIT_ACCEPTED", source: `${SPLIT}const t = tag(e.side("o.bottom"));\n`, patch: (doc) => captureBottom(doc) },
  ref_set_changed: {
    target: "REF_SET_CHANGED",
    source: `${BOX}const t = tag(e.sides().some());\n`,
    patch: (doc) => {
      (featureOf(doc, "t")["target"] as Feature)["capture"] = sideCapture("plane");
      const m = ((featureOf(doc, "t")["target"] as Feature)["capture"] as { members: Feature[] }).members[0]!;
      m["via"] = "broad";
    },
  },
};

/** Program label → complete CadScript v1 source. */
export function oracleProgramSource(label: string): string {
  const p = ORACLE_PROGRAMS[label];
  if (!p) throw new Error(`no oracle program ${label}`);
  return IMPORT + p.source;
}

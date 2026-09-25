/**
 * CadScript v1 probes for Forge's engine-prefixed codes whose details say what to change (the
 * FORGE_ codes of `PLAYBOOK_V1`; review: they got the "engine-internal … simplify the geometry"
 * text). Forge-only — the oracle raises catalogue codes or nothing for them — so they are not in
 * `oracle-programs.ts`, whose programs both engines evaluate.
 *
 * Each probe keeps the codes and details Forge reported for it (forge/target/debug/aicad,
 * 2026-09-25), per feature. The offline tests compute the hints from them;
 * `AICAD_RECORD_FIXTURES=check-forge-v1` evaluates every probe again and fails when Forge now
 * reports other codes or details (messages are not compared: hints never read them). Move them into
 * `v1-forge-reports.json` at the next `forge-v1` re-recording if they should replay whole reports.
 */
const IMPORT = 'import { part, sketch, rect, circle, extrude, XY, XZ, X, hole, grid, linearPattern } from "@aicad/std";\n';

/** One code a probe raises: the feature (by CadScript name), whether it is the error or a warning, and its details. */
export interface ProbeFinding {
  feature: string;
  code: string;
  severity: "error" | "warning" | "info";
  details: Record<string, unknown>;
}

export interface ForgeProbe {
  /** CadScript v1 body (after the import). */
  source: string;
  /** What Forge reported (the error and every warning of the listed features, in report order). */
  findings: readonly ProbeFinding[];
}

export const FORGE_PROBES: Readonly<Record<string, ForgeProbe>> = {
  // A 60 × 20 × 10 slab whose middle is pocketed from below to 4 mm: the blind M3 holes' copies land on the 4 mm wall.
  pattern_blind_hole_breaks_through: {
    source:
      'part("p");\nconst s = sketch(XY, { o: rect({ center: [20, 0], w: 60, h: 20 }) });\nconst slab = extrude(s, { distance: 10 });\n' +
      'const pk = sketch(XY, { q: rect({ center: [30, 0], w: 16, h: 30 }) });\nconst pocket = extrude(pk, { distance: 6, op: "cut", targets: slab });\n' +
      'const h = hole(slab.cap("end"), { at: { a: [0, 0], b: [0, 8] }, size: "M3", d: 3, depth: { blind: 6 }, thread: { depth: 8 } });\n' +
      "const row = linearPattern([h], { dir: X, count: 2, spacing: 30 });\n",
    findings: [
      { feature: "h", code: "FORGE_HOLE_THREAD_DEEPER_THAN_HOLE", severity: "warning", details: { at: "a", depth: 8, hole_depth: 6 } },
      { feature: "h", code: "FORGE_HOLE_THREAD_DEEPER_THAN_HOLE", severity: "warning", details: { at: "b", depth: 8, hole_depth: 6 } },
      { feature: "row", code: "FORGE_PATTERN_HOLE_BREAKS_THROUGH", severity: "warning", details: { at: "a", index: [1], seed: "f_h" } },
      { feature: "row", code: "FORGE_PATTERN_HOLE_BREAKS_THROUGH", severity: "warning", details: { at: "b", index: [1], seed: "f_h" } },
    ],
  },
  // The slab spans x ∈ [−10, 50]: moved 45 mm, position a (x = 0) lands at 45, position b (x = 8) at 53, off the body.
  pattern_hole_position_missed: {
    source:
      'part("p");\nconst s = sketch(XY, { o: rect({ center: [20, 0], w: 60, h: 20 }) });\nconst slab = extrude(s, { distance: 10 });\n' +
      'const h = hole(slab.cap("end"), { at: { a: [0, 0], b: [8, 0] }, d: 3, depth: { blind: 4 } });\n' +
      "const row = linearPattern([h], { dir: X, count: 2, spacing: 45 });\n",
    findings: [{ feature: "row", code: "FORGE_PATTERN_HOLE_POSITION_MISSED", severity: "warning", details: { at: "b", index: [1], seed: "f_h" } }],
  },
  // 101 × 100 grid positions: one hole feature builds at most 10 000.
  hole_too_many_positions: {
    source:
      'part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 400, h: 400 }) });\nconst slab = extrude(s, { distance: 2 });\n' +
      'const h = hole(slab.cap("end"), { at: grid({ nx: 101, ny: 100, dx: 3, dy: 3 }), d: 1, depth: "through" });\n',
    findings: [{ feature: "h", code: "FORGE_HOLE_TOO_MANY_POSITIONS", severity: "error", details: { field: "/at/grid", max: 10000, value: 10100 } }],
  },
  // A hole from the top drilled up to a cylindrical channel: Forge drills upTo planes only.
  hole_up_to_cylinder: {
    source:
      'part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 40, h: 20 }) });\nconst blk = extrude(s, { distance: 20 });\n' +
      'const c = sketch(XZ, { c: circle({ center: [0, 8], radius: 4 }) });\nconst ch = extrude(c, { distance: 30, op: "cut", targets: blk, direction: "symmetric" });\n' +
      'const h = hole(blk.cap("end"), { at: { a: [0, 0] }, d: 3, depth: { upTo: ch.side("c") } });\n',
    findings: [{ feature: "h", code: "FORGE_HOLE_UP_TO_UNSUPPORTED", severity: "error", details: { surface: "cylinder" } }],
  },
};

export function forgeProbeSource(label: string): string {
  return IMPORT + FORGE_PROBES[label]!.source;
}

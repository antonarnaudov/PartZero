/**
 * CadScript v1 scenarios whose Forge reports the v1 offline tests replay
 * (`test/fixtures/v1-forge-reports.json`, recorded by `record-v1-fixtures.test.ts`). Each one makes
 * Forge raise one catalogue code (or several: the consumers' DEPENDENCY_FAILED / PARAM_FAILED).
 */

const IMPORT =
  'import { part, sketch, line, arc, circle, point, extrude, revolve, boolean, frame, XY, XZ, YZ, X, Y, Z, param, rect, polygon, C, tag, bodies, datumPlane, datumAxis, sqrt, hole, fillet, chamfer, shell, draft, linearPattern, thread } from "@aicad/std";\n';

const RECT = 'part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 20 }) });\nconst e = extrude(s, { distance: 5 });\n';

const LOOP = (constraints: string): string =>
  `part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]), b: line([10, 0], [10, 10]), c: line([10, 10], [0, 10]), d: line([0, 10], [0, 0]) }, { constraints: { ${constraints} } });\nconst e = extrude(s, { distance: 5 });\n`;

const body: Record<string, string> = {
  // ── Parameters and expressions (E) ──
  expr_domain: 'const k = param(2, { unit: "ratio" });\nconst w = param(10 * sqrt(k - 5));\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: w, h: 10 }) });\nconst e = extrude(s, { distance: 5 });\n',
  not_integer: 'const a = param(7, { unit: "count" });\nconst n = param(a / 2, { unit: "count" });\npart("p");\nconst s = sketch(XY, { o: polygon({ n: n, circumradius: 10 }) });\nconst e = extrude(s, { distance: 5 });\n',
  param_range: 'const a = param(10);\nconst b = param(a * 2, { max: 15 });\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 10, h: b }) });\nconst e = extrude(s, { distance: 5 });\n',
  // ── Range checks on expressions (E) ──
  invalid_distance: 'const t = param(4);\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 10, h: 10 }) });\nconst e = extrude(s, { distance: t - 4 });\n',
  invalid_angle: 'const a = param(0, { unit: "deg" });\npart("p");\nconst s = sketch(XZ, { o: rect({ center: [10, 5], w: 5, h: 10 }) });\nconst r = revolve(s, { axis: { origin: [0, 0], direction: [0, 1] }, angle: a });\n',
  invalid_axis: 'const k = param(0, { unit: "ratio" });\npart("p");\nconst s = sketch(XZ, { o: rect({ center: [10, 5], w: 5, h: 10 }) });\nconst r = revolve(s, { axis: { origin: [0, 0], direction: [0, k] }, angle: 90 });\n',
  invalid_plane: 'const k = param(0, { unit: "ratio" });\npart("p");\nconst s = sketch(frame({ origin: [0, 0, 0], normal: [0, 0, k], xDir: [1, 0, 0] }), { o: rect({ center: [10, 5], w: 5, h: 10 }) });\n',
  invalid_count: 'const n = param(2, { unit: "count" });\npart("p");\nconst s = sketch(XY, { o: polygon({ n: n, circumradius: 10 }) });\nconst e = extrude(s, { distance: 5 });\n',
  invalid_value: 'const r = param(12);\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 20, r: r }) });\nconst e = extrude(s, { distance: 5 });\n',
  degenerate_curve: 'const r = param(2);\npart("p");\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: r - 2 }) });\nconst e = extrude(s, { distance: 5 });\n',
  inconsistent_arc: 'const r = param(6);\npart("p");\nconst s = sketch(XY, { a: arc({ start: [r, 0], end: [-5, 0], center: [0, 0], ccw: true }), l: line([-5, 0], [r, 0]) });\nconst e = extrude(s, { distance: 5 });\n',
  // ── Sketch geometry ──
  open_loop: 'part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]), b: line([10, 0], [10, 10]), c: line([10, 10], [0, 10.5]), d: line([0, 10], [0, 0]) });\nconst e = extrude(s, { distance: 5 });\n',
  branching: 'part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]), b: line([10, 0], [10, 10]), c: line([10, 10], [0, 0]), d: line([0, 0], [-10, 5]), f: line([-10, 5], [0, 0]) });\nconst e = extrude(s, { distance: 5 });\n',
  crossing_circle: 'part("p");\nconst s = sketch(XY, { a: line([-10, -10], [10, -10]), b: line([10, -10], [10, 10]), c: line([10, 10], [-10, 10]), d: line([-10, 10], [-10, -10]), h: circle({ center: [8, 0], radius: 3 }) });\nconst e = extrude(s, { distance: 5 });\n',
  crossing_compound: 'part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 20 }), h: circle({ center: [9, 0], radius: 3 }) });\nconst e = extrude(s, { distance: 5 });\n',
  overlap: 'part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]), b: line([10, 0], [0, 0]) });\nconst e = extrude(s, { distance: 5 });\n',
  revolve_axis: 'part("p");\nconst s = sketch(XZ, { o: rect({ center: [3, 5], w: 10, h: 10 }) });\nconst r = revolve(s, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });\n',
  no_regions: 'part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0], { construction: true }), p1: point([1, 1]) });\nconst e = extrude(s, { distance: 5 });\n',
  region_not_found: 'part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 20 }), h: circle({ center: [0, 0], radius: 3 }) });\nconst e = extrude(s, { distance: 5, regions: ["h"] });\n',
  sketch_suppressed: 'part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 20 }) }, { suppressed: true });\nconst e = extrude(s, { distance: 5 });\n',
  dependency_suppressed: `${RECT}const t = tag(e.cap("end"), { suppressed: true });\nconst s2 = sketch(t, { c: circle({ center: [0, 0], radius: 2 }) });\n`,
  // ── Constrained sketches ──
  conflict: LOOP('h1: C.horizontal("a"), h2: C.horizontal("c"), v1: C.vertical("b"), v2: C.vertical("d"), w1: C.distance("a.start", "a.end", 10), w2: C.distance("c.start", "c.end", 12), f: C.fix("a.start")'),
  under_constrained: LOOP('h1: C.horizontal("a"), v1: C.vertical("b")'),
  redundant: LOOP('h1: C.horizontal("a"), h2: C.horizontal("c"), v1: C.vertical("b"), v2: C.vertical("d"), p1: C.parallel("a", "c"), w1: C.distance("a.start", "a.end", 10), w2: C.distance("b.start", "b.end", 10), f: C.fix("a.start")'),
  invalid_dimension: `const t = param(3);\n${LOOP('w1: C.distance("a.start", "a.end", t - 3)')}`,
  // A triangle stored clockwise; the fixes pull its apex across the base (forge-sketch constrained.rs, a_jump_to_the_mirrored_configuration_is_flagged).
  loop_flipped: 'part("p");\nconst s = sketch(XY, { t1: line([0, 0], [10, 0]), t2: line([10, 0], [5, -2]), t3: line([5, -2], [0, 0]) }, { constraints: { f1: C.fix("t1.start"), f2: C.fix("t1.end"), f3: C.fix("t2.end", { x: 5, y: 5 }) } });\nconst e = extrude(s, { distance: 5 });\n',
  // Internal tangency asked of two arcs that meet at a joint externally: the solver keeps the stored configuration and the independent check rejects it (forge-sketch constrained.rs).
  solve_failed: 'part("p");\nconst s = sketch(XY, { a1: arc({ start: [0, 10], end: [10, 0], center: [0, 0], ccw: false, construction: true }), a2: arc({ start: [10, 0], end: [15, -5], center: [15, 0], ccw: true, construction: true }) }, { constraints: { t: C.tangent("a1", "a2", { internal: true }) } });\n',
  // A triangle enclosing exactly tol² = 1e-12 mm² (forge-check degenerate_loop.rs: the sketch stage rejects it).
  degenerate_loop: 'part("p");\nconst s = sketch(XY, { a: line([0, 0], [0.000002, 0]), b: line([0.000002, 0], [0.000001, 0.000001]), c: line([0.000001, 0.000001], [0, 0]) });\nconst e = extrude(s, { distance: 5 });\n',
  // ── References ──
  ref_ambiguous: `${RECT}const t = tag(e.sides().one());\n`,
  ref_missing: `${RECT}const t = tag(e.faces().cylinders().one());\n`,
  ref_cardinality: `${RECT}const t = tag(e.sides().exactly(3));\n`,
  // ── Planes, axes, datums ──
  plane_not_planar: 'part("p");\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: 10 }) });\nconst e = extrude(s, { distance: 5 });\nconst s2 = sketch(e.side("c"), { c: circle({ center: [0, 0], radius: 1 }) });\n',
  plane_degenerate: `${RECT}const s2 = sketch({ face: e.cap("end"), xDir: [0, 0, 1] }, { c: circle({ center: [0, 0], radius: 2 }) });\n`,
  axis_unsupported: `${RECT}const a = datumAxis({ cylinder: e.side("o.left") });\n`,
  datum_degenerate: 'part("p");\nconst m = datumPlane({ midplane: [XY, XZ] });\n',
  // ── Booleans ──
  boolean_no_intersection: `${RECT}const s2 = sketch(XY, { o: rect({ center: [100, 0], w: 5, h: 5 }) });\nconst j = extrude(s2, { distance: 5, op: "join", targets: e });\n`,
  boolean_touching: `${RECT}const s2 = sketch(XY, { o: rect({ center: [20, 20], w: 20, h: 20 }) });\nconst j = extrude(s2, { distance: 5, op: "join", targets: e });\n`,
  boolean_empty: `${RECT}const s2 = sketch(XY, { o: rect({ center: [100, 0], w: 5, h: 5 }) });\nconst j = extrude(s2, { distance: 5, op: "intersect", targets: e });\n`,
  boolean_split: `${RECT}const s2 = sketch(XY, { o: rect({ center: [0, 0], w: 2, h: 40 }) });\nconst c = extrude(s2, { distance: 5, op: "cut", targets: e });\n`,
  boolean_consumed: `${RECT}const s2 = sketch(XY, { o: rect({ center: [0, 0], w: 40, h: 40 }) });\nconst c = extrude(s2, { distance: 5, op: "cut", targets: e });\n`,
  boolean_tool_is_target: `${RECT}const b = boolean("join", { targets: e, tools: e });\n`,
  // ── Operations Forge did not evaluate when these were written (labels kept: the oracle recording
  //    uses them). Forge evaluates hole, fillet and shell now (ok models); draft is still rejected
  //    with UNSUPPORTED_FEATURE. The capability probe (capabilities-v1.test.ts) tracks which. ──
  unsupported_hole: `${RECT}const h = hole(e.cap("end"), { at: { a: [0, 0] }, d: 3, depth: "through" });\n`,
  unsupported_fillet: `${RECT}const f = fillet(e.sides().edges().parallel(Z), { r: 2 });\n`,
  unsupported_shell: `${RECT}const sh = shell(e, { open: e.cap("end"), thickness: 1 });\n`,
  unsupported_draft: `${RECT}const dr = draft(e.sides(), { neutral: XY, angle: 2 });\n`,
  // ── Modelled threads (§6.13): Forge raises each; the oracle checks only some of them ──
  thread_diameter: `${RECT}const h = hole(e.cap("end"), { at: { a: [0, 0] }, d: 5, depth: "through" });\nconst t = thread(h.wall("a"), { standard: "M8" });\n`,
  thread_face: `${RECT}const t = thread(e.cap("end"), { standard: "M8" });\n`,
  thread_length: `${RECT}const h = hole(e.cap("end"), { at: { a: [0, 0] }, d: 6.8, depth: "through" });\nconst t = thread(h.wall("a"), { standard: "M8", length: 8 });\n`,
  thread_end_close: `${RECT}const h = hole(e.cap("end"), { at: { a: [0, 0] }, d: 6.8, depth: "through" });\nconst t = thread(h.wall("a"), { standard: "M8", length: 4.9995 });\n`,
  thread_end_inside: `${RECT}const h = hole(e.cap("end"), { at: { a: [0, 0] }, d: 6.8, depth: "through" });\nconst t = thread(h.wall("a"), { standard: "M8", offset: 1, length: 3 });\n`,
  thread_interference: `${RECT}const h = hole(e.cap("end"), { at: { a: [6.2, 0] }, d: 6.8, depth: "through" });\nconst t = thread(h.wall("a"), { standard: "M8" });\n`,
  thread_invalid: `${RECT}const h = hole(e.cap("end"), { at: { a: [0, 0] }, d: 6.8, depth: "through" });\nconst t = thread(h.wall("a"), { major: 1, pitch: 1 });\n`,
  // ── Healthy models (tool tests) ──
  ok_plate: 'const width = param(80, { min: 20, max: 300, note: "outer width" });\nconst depth = param(50);\nconst thick = param(8, { min: 2 });\npart("plate");\nconst base = sketch(XY, { outline: rect({ center: [0, 0], w: width, h: depth }) });\nconst slab = extrude(base, { distance: thick });\n',
};

/** Scenario label → complete CadScript v1 source. */
export const V1_SCENARIOS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, IMPORT + v]));

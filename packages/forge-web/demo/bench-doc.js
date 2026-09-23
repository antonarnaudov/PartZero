// @ts-check
/**
 * A synthetic 25-feature IR v0 document for the spike-5 "dimension edit ≤ 150 ms" check.
 * IR v0 has no booleans, so the part is a multi-body "fixture": a rounded base plate with
 * holes, four standoffs, two gussets, a revolved dome knob, a torus handle, a cone, a slot
 * boss (extruded both ways from one sketch) and a perforated plate. Every sketch above the
 * base sits at z = `thickness`, so editing that one dimension re-evaluates every feature.
 *
 * Shared by the Node bench (scripts/bench.mjs) and the demo page.
 */

/** @param {string} id @param {[number, number]} start @param {[number, number]} end */
const line = (id, start, end) => ({ kind: "line", id, start, end });
/** @param {string} id @param {[number, number]} start @param {[number, number]} end @param {[number, number]} center */
const arc = (id, start, end, center) => ({ kind: "arc", id, start, end, center, ccw: true });
/** @param {string} id @param {[number, number]} center @param {number} radius */
const circle = (id, center, radius) => ({ kind: "circle", id, center, radius });
/** @param {[number, number, number]} origin @param {[number, number, number]} normal */
const frame = (origin, normal = [0, 0, 1]) => ({ origin, normal, x_dir: [1, 0, 0] });

/**
 * @param {number} thickness base plate thickness (mm), the edited dimension
 * @returns {object} an `aicad.ir/0` document
 */
export function benchDocument(thickness = 6) {
  const t = thickness;
  /** @type {object[]} */
  const features = [];
  let n = 0;
  /** @param {string} name @param {unknown} plane @param {object[]} curves */
  const sketch = (name, plane, curves) => {
    features.push({ type: "sketch", id: `s${++n}`, name, plane, curves });
    return name;
  };
  /** @param {string} name @param {string} sk @param {number} distance @param {string} [direction] */
  const extrude = (name, sk, distance, direction) =>
    features.push({ type: "extrude", id: `f${++n}`, name, sketch: sk, distance, ...(direction ? { direction } : {}) });
  /** @param {string} name @param {string} sk */
  const revolve = (name, sk) =>
    features.push({ type: "revolve", id: `f${++n}`, name, sketch: sk, axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

  // 1–2: rounded base plate 160 × 100, R8 corners, six Ø6.4 holes.
  const base = sketch("base_profile", "XY", [
    line("b_bottom", [-72, -50], [72, -50]),
    arc("b_c1", [72, -50], [80, -42], [72, -42]),
    line("b_right", [80, -42], [80, 42]),
    arc("b_c2", [80, 42], [72, 50], [72, 42]),
    line("b_top", [72, 50], [-72, 50]),
    arc("b_c3", [-72, 50], [-80, 42], [-72, 42]),
    line("b_left", [-80, 42], [-80, -42]),
    arc("b_c4", [-80, -42], [-72, -50], [-72, -42]),
    ...[-60, 0, 60].flatMap((x, i) => [circle(`h${i}a`, [x, -38], 3.2), circle(`h${i}b`, [x, 38], 3.2)]),
  ]);
  extrude("base", base, t);

  // 3–10: four standoffs (Ø10 with an M3 hole), 12 tall.
  [[-66, -36], [66, -36], [66, 36], [-66, 36]].forEach(([x, y], i) => {
    const s = sketch(`standoff${i}_profile`, frame([x, y, t]), [circle("outer", [0, 0], 5), circle("hole", [0, 0], 1.6)]);
    extrude(`standoff${i}`, s, 12);
  });

  // 11–14: two gussets (triangles on XZ and YZ), 4 thick, centred on their planes.
  const ga = sketch("gusset_a_profile", "XZ", [line("g1", [20, t], [40, t]), line("g2", [40, t], [20, t + 15]), line("g3", [20, t + 15], [20, t])]);
  extrude("gusset_a", ga, 4, "symmetric");
  const gb = sketch("gusset_b_profile", "YZ", [line("g1", [15, t], [30, t]), line("g2", [30, t], [15, t + 12]), line("g3", [15, t + 12], [15, t])]);
  extrude("gusset_b", gb, 4, "symmetric");

  // 15–16: revolved dome knob (cylinder r10 h6 + hemisphere); the profile edge on the axis makes no face.
  const dome = sketch("dome_profile", frame([-40, 30, t], [0, -1, 0]), [
    line("d1", [0, 0], [10, 0]),
    line("d2", [10, 0], [10, 6]),
    arc("d3", [10, 6], [0, 16], [0, 6]),
    line("d4", [0, 16], [0, 0]),
  ]);
  revolve("dome", dome);

  // 17–18: torus handle (R12, r3) floating above the plate.
  const torus = sketch("torus_profile", frame([-50, -30, t + 10], [0, -1, 0]), [circle("tube", [12, 0], 3)]);
  revolve("handle", torus);

  // 19–20: cone (r10, h14).
  const cone = sketch("cone_profile", frame([40, -30, t], [0, -1, 0]), [line("c1", [0, 0], [10, 0]), line("c2", [10, 0], [0, 14]), line("c3", [0, 14], [0, 0])]);
  revolve("cone", cone);

  // 21–23: slot boss, extruded up and (from the same sketch) down.
  const slot = sketch("slot_profile", frame([0, -28, t]), [
    line("s1", [-15, -4], [15, -4]),
    arc("s2", [15, -4], [15, 4], [15, 0]),
    line("s3", [15, 4], [-15, 4]),
    arc("s4", [-15, 4], [-15, -4], [-15, 0]),
  ]);
  extrude("slot_up", slot, 3);
  extrude("slot_down", slot, 2, "reverse");

  // 24–25: perforated plate 50 × 20 with twelve Ø3 holes.
  const holes = [];
  for (let i = 0; i < 6; i++) for (const y of [-4, 4]) holes.push(circle(`p${i}_${y > 0 ? "t" : "b"}`, [-20 + 8 * i, y], 1.5));
  const perf = sketch("perforated_profile", frame([0, 30, t]), [
    line("r1", [-25, -10], [25, -10]),
    line("r2", [25, -10], [25, 10]),
    line("r3", [25, 10], [-25, 10]),
    line("r4", [-25, 10], [-25, -10]),
    ...holes,
  ]);
  extrude("perforated", perf, 2);

  return {
    schema: "aicad.ir/0",
    meta: { name: "bench_fixture_25", description: `synthetic 25-feature multi-body fixture, base thickness ${t} mm` },
    parts: [{ id: "p1", name: "fixture", features }],
  };
}

/** Number of features in {@link benchDocument}. */
export const BENCH_FEATURES = 25;

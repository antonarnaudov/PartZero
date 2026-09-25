/**
 * The IR v1 feature reference for an agent that operates the op tools (the live agent, MCP
 * clients): what `add_feature` / `set_field` take, as JSON — planes, sketch curves and constraints,
 * extrude, revolve, hole, fillet, chamfer, shell, pattern, datums, tags — and the semantic
 * reference grammar (Ref and queries, SPEC-v1 §5). Condensed from SPEC-v1-DRAFT.md §3–§6.
 *
 * The worked recipes below are real tool calls: `test/ops-reference.test.ts` runs every one on the
 * Forge engine and fails if any step is refused or leaves a feature failing, so the reference
 * cannot drift from what the engine accepts.
 */

/** One tool call of a recipe. */
export interface RecipeCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface Recipe {
  id: string;
  title: string;
  calls: RecipeCall[];
}

const j = (v: unknown): string => JSON.stringify(v);
const cap = (feature: string, end: "start" | "end" = "end") => ({ kind: "face", q: { op: "cap", feature, end } });

/** Worked examples: every call builds (tested). */
export const OPS_RECIPES: readonly Recipe[] = [
  {
    id: "cube-bore-fillets",
    title: "A 40 mm cube with a Ø10 through hole from the top and 2 mm fillets on the vertical edges",
    calls: [
      { tool: "add_param", input: { name: "size", unit: "mm", value: 40, min: 10, note: "cube edge" } },
      { tool: "add_feature", input: { feature_json: j({ type: "sketch", id: "base", name: "base", plane: "XY", curves: [{ kind: "rect", id: "outline", center: [0, 0], w: "size", h: "size" }] }), note: "Sketch the base square on XY" } },
      { tool: "add_feature", input: { feature_json: j({ type: "extrude", id: "cube", name: "cube", sketch: "base", distance: "size" }), note: "Extrude it to a cube" } },
      { tool: "find_entities", input: { ref_json: j({ kind: "edge", q: { op: "filter", where: { parallel: "Z" }, of: { op: "edges", of: { op: "sides", feature: "cube" } } } }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "fillet", id: "rounds", name: "rounds", r: 2, edges: { kind: "edge", q: { op: "filter", where: { parallel: "Z" }, of: { op: "edges", of: { op: "sides", feature: "cube" } } } } }), note: "Round the four vertical edges (2 mm)" } },
      { tool: "add_feature", input: { feature_json: j({ type: "hole", id: "bore", name: "bore", on: { face: cap("cube") }, at: { list: [{ id: "c", at: [0, 0] }] }, d: 10, depth: "through" }), note: "Drill the Ø10 hole through from the top" } },
      { tool: "check_model", input: {} },
    ],
  },
  {
    id: "plate-holes-chamfer",
    title: "A parametric plate: rounded corners, four M3 counterbored holes on a grid, a chamfered top edge",
    calls: [
      {
        tool: "apply_ops",
        input: {
          ops_json: j([
            { op: "addParam", name: "width", unit: "mm", value: 80, min: 20 },
            { op: "addParam", name: "depth", unit: "mm", value: 50, min: 20 },
            { op: "addParam", name: "thick", unit: "mm", value: 6, min: 2 },
          ]),
          label: "Plate parameters",
          note: "Add width, depth and thickness parameters",
        },
      },
      { tool: "add_feature", input: { feature_json: j({ type: "sketch", id: "outline_sk", name: "outline_sk", plane: "XY", curves: [{ kind: "rect", id: "outline", center: [0, 0], w: "width", h: "depth", r: 5 }] }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "extrude", id: "plate", name: "plate", sketch: "outline_sk", distance: "thick" }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "hole", id: "mounts", name: "mounts", on: { face: cap("plate") }, at: { grid: { nx: 2, ny: 2, dx: "width - 16", dy: "depth - 16" } }, size: "M3", depth: "through", cbore: "iso4762" }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "chamfer", id: "edge_break", name: "edge_break", d: 0.8, edges: { kind: "edge", q: { op: "filter", where: { type: "line" }, of: { op: "edges", of: { op: "cap", feature: "plate", end: "end" } } } } }) } },
    ],
  },
  {
    id: "boss-pocket-shell",
    title: "A box shelled open at the top, a boss joined on its floor, a pocket cut into a wall",
    calls: [
      { tool: "add_feature", input: { feature_json: j({ type: "sketch", id: "box_sk", name: "box_sk", plane: "XY", curves: [{ kind: "rect", id: "o", center: [0, 0], w: 60, h: 40 }] }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "extrude", id: "box", name: "box", sketch: "box_sk", distance: 25 }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "shell", id: "hollow", name: "hollow", thickness: 2, body: { kind: "body", q: { op: "body", feature: "box" } }, open: cap("box") }) } },
      { tool: "list_entities", input: { kind: "face", of: "hollow", near: [0, 0, 2] } },
      {
        tool: "add_feature",
        input: {
          feature_json: j({
            type: "sketch",
            id: "boss_sk",
            name: "boss_sk",
            plane: { face: { kind: "face", q: { op: "extreme", dir: "+Z", which: "min", of: { op: "filter", where: { normal: "+Z" }, of: { op: "created", feature: "hollow" } } }, card: "one" } },
            curves: [{ kind: "circle", id: "ring", center: [0, 0], radius: 5 }],
          }),
          note: "Sketch the boss on the inside floor",
        },
      },
      { tool: "add_feature", input: { feature_json: j({ type: "extrude", id: "boss", name: "boss", sketch: "boss_sk", distance: 8, op: "join", targets: { kind: "body", q: { op: "body", feature: "box" } } }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "sketch", id: "slot_sk", name: "slot_sk", plane: "XZ", curves: [{ kind: "slot", id: "s", a: [-10, 15], b: [10, 15], w: 6 }] }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "extrude", id: "slot_cut", name: "slot_cut", sketch: "slot_sk", distance: 30, direction: "reverse", op: "cut", targets: "all" }) } },
    ],
  },
  {
    id: "revolve-pattern",
    title: "A revolved knob with a bolt-circle of holes (circular pattern) and a mirrored rib",
    calls: [
      {
        tool: "add_feature",
        input: {
          feature_json: j({
            type: "sketch",
            id: "profile",
            name: "profile",
            plane: "XZ",
            curves: [
              { kind: "line", id: "base", start: [0, 0], end: [20, 0] },
              { kind: "line", id: "rim", start: [20, 0], end: [20, 12] },
              { kind: "line", id: "top", start: [20, 12], end: [0, 12] },
              { kind: "line", id: "axis_side", start: [0, 12], end: [0, 0] },
            ],
          }),
        },
      },
      { tool: "add_feature", input: { feature_json: j({ type: "revolve", id: "knob", name: "knob", sketch: "profile", axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "hole", id: "pin", name: "pin", on: { face: { kind: "face", q: { op: "filter", where: { normal: "+Z" }, of: { op: "created", feature: "knob" } }, card: "one" } }, at: { list: [{ id: "p", at: [14, 0] }] }, d: 3, depth: { blind: 6 } }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "pattern", id: "pins", name: "pins", seed: { features: ["pin"] }, layout: { circular: { axis: "Z", count: 6 } } }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "sketch", id: "rib_sk", name: "rib_sk", plane: "XY", curves: [{ kind: "rect", id: "r", center: [22, 0], w: 10, h: 3 }] }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "extrude", id: "rib", name: "rib", sketch: "rib_sk", distance: 5, op: "join", targets: { kind: "body", q: { op: "body", feature: "knob" } } }) } },
      { tool: "add_feature", input: { feature_json: j({ type: "pattern", id: "rib2", name: "rib2", seed: { features: ["rib"] }, layout: { mirror: { plane: "YZ" } } }) } },
    ],
  },
  {
    id: "constrained-sketch",
    title: "A constrained sketch: lines with horizontal/vertical constraints and dimensions bound to parameters",
    calls: [
      { tool: "apply_ops", input: { ops_json: j([{ op: "addParam", name: "w", unit: "mm", value: 30 }, { op: "addParam", name: "h", unit: "mm", value: 20 }]) } },
      {
        tool: "add_feature",
        input: {
          feature_json: j({
            type: "sketch",
            id: "frame_sk",
            name: "frame_sk",
            plane: "XY",
            curves: [
              { kind: "line", id: "b", start: [0, 0], end: [30, 0] },
              { kind: "line", id: "r", start: [30, 0], end: [30, 20] },
              { kind: "line", id: "t", start: [30, 20], end: [0, 20] },
              { kind: "line", id: "l", start: [0, 20], end: [0, 0] },
            ],
            constraints: [
              { id: "h1", type: "horizontal", line: "b" },
              { id: "h2", type: "horizontal", line: "t" },
              { id: "v1", type: "vertical", line: "l" },
              { id: "v2", type: "vertical", line: "r" },
              { id: "dw", type: "distance", a: "b.start", b: "b.end", value: "w" },
              { id: "dh", type: "distance", a: "l.end", b: "l.start", value: "h" },
              { id: "pin", type: "fix", entity: "b.start" },
            ],
          }),
        },
      },
      { tool: "add_feature", input: { feature_json: j({ type: "extrude", id: "frame_body", name: "frame_body", sketch: "frame_sk", distance: 4 }) } },
      { tool: "set_param", input: { name: "w", value: 36, note: "Make the frame 36 mm wide" } },
      { tool: "set_field", input: { feature: "frame_sk", path: "/constraints/5/value", value_json: j({ expr: "h + 2" }), note: "Tie the height to h + 2" } },
    ],
  },
];

function recipeText(r: Recipe): string {
  const lines = [`### ${r.title}`];
  for (const c of r.calls) {
    const shown = Object.fromEntries(Object.entries(c.input).map(([k, v]) => [k, typeof v === "string" && k.endsWith("_json") ? JSON.parse(v) : v]));
    lines.push(`- ${c.tool} ${JSON.stringify(shown)}`);
  }
  return lines.join("\n");
}

/** The reference text (system prompt block). `*_json` arguments are shown as the objects they carry. */
export function opsReference(): string {
  return [
    "# Feature reference (IR v1 JSON for add_feature / set_field)",
    "",
    "Units are mm and degrees. Every numeric field takes a number or an expression string over parameters (\"size / 2\"). Ids and names match [A-Za-z_][A-Za-z0-9_]*; give features short meaningful ids (they are what later features and queries reference) and make each feature's name equal its id; leave `author` out. Names may not be JavaScript keywords or builtins (sketch, extrude, revolve, part, line, arc, circle, frame, doc, XY, …); parameter names also not min, max, body, hole, tag, point, rect, slot, X, Y, Z, C, ….",
    "",
    "## Planes and axes",
    '- Plane: "XY" (normal +Z), "XZ" (normal −Y: an extrude from XZ goes toward −Y; (u, v) = (x, z)), "YZ" (normal +X; (u, v) = (y, z)); a face {"face": <face Ref, card one>} (its outward normal; on a top cap of an XY sketch (u, v) = (x, y)); {"datum": "<datum_plane id>"}; {"origin": [x,y,z], "normal": [..], "x_dir": [..]}.',
    '- Axis (patterns, datums): "X" | "Y" | "Z", {"edge": <edge Ref>}, {"cylinder": <face Ref>}, {"datum": "<id>"}, {"line": {"origin", "direction"}}. Dir (query predicates, linear patterns): "+X" … "-Z" signed, "X" | "Y" | "Z" unsigned.',
    "",
    "## sketch",
    '{"type":"sketch","id","name","plane", "curves":[…], "constraints"?:[…]}. Curves (each with an id; "construction": true for helpers):',
    '- line {start:[u,v], end}; arc {center, start, end, ccw: bool}; circle {center, radius}; point {at};',
    '- rect {center | corner (lower-left), w, h, r? (corner radius)} → members <id>.bottom .right .top .left (+ .c_br … when r > 0);',
    '- slot {a, b, w} (round ends) → <id>.right .cap_b .left .cap_a; polygon {center, n, circumradius | inradius | across_flats | side, rotation?} → <id>.e0 …',
    "- A profile is closed loops: every line/arc end meets exactly one other end; circles/rects/slots/polygons close themselves. Inner loops are holes in the region.",
    '- Explicit mode (no constraints): sizes may be expressions — the way to make a sketch parametric. Constrained mode (constraints present): literal lines, arcs, circles, points only (no rect/slot/polygon); dimensions carry the parameters. Constraints: {id, type, …}: coincident {a,b points}; horizontal/vertical {line}; parallel/perpendicular/equal {a,b}; tangent {a,b}; distance {a point, b point|line, value}; angle {a,b lines, value}; radius/diameter {curve, value}; point_on_line/midpoint {point, line}; point_on_circle {point, curve}; symmetric {a,b points, line}; fix {entity}. Points: "l.start", "l.end", "a.center", "c.center", point ids. Touching ends weld automatically.',
    "",
    "## Solids",
    '- extrude {sketch, distance, direction?: "normal" | "reverse" | "symmetric", regions?: "all" | [curve ids], op?: "new_body" | "join" | "cut" | "intersect", targets?: "all" | <body Ref>} — targets are required with join/cut/intersect. One printable part is one body: join what touches.',
    '- revolve {sketch, axis: {origin:[u,v], direction:[du,dv]} (in sketch coordinates), angle (360 = full), direction?, op?, targets?} — the profile must stay on one side of the axis.',
    '- boolean {op: "join" | "cut" | "intersect", targets: <body Ref>, tools: <body Ref>, keep_tools?}.',
    '- hole {on: {"face": <planar face Ref>}, at: {list: [{id, at:[u,v]}]} | {grid: {nx, ny, dx, dy, center?}} | {circle: {n, d, center?, start?}} | {points: {sketch, ids}}, size: "M2"…"M8" (fit?: close|normal|loose|tap) or d, depth: "through" | {blind: h} | {up_to: <face Ref>}, cbore?: "iso4762" | {d, depth}, csink?: "iso10642" | {d, angle}, insert?: "std", thread?: true, tip?: 118 | "flat", flip?}. Positions are (u, v) in the face\'s frame; the hole drills into the material.',
    '- fillet {edges: <edge Ref, card some>, r}; chamfer {edges, d} (or {d, d2, side} / {d, angle, side}). Fillet before holes/pockets that would cut the edges; a too-large r is refused with the largest r that fits.',
    '- shell {body: <body Ref>, open?: <face Ref>, thickness, direction?: "inward" | "outward"}.',
    '- pattern {seed: {features: [extrude|revolve|hole ids]} | {bodies: <body Ref>}, layout: {linear: {dir, count, spacing, dir2?, count2?, spacing2?}} | {circular: {axis, count, angle?}} | {mirror: {plane}}, skip?: [[i]]}.',
    '- datum_plane {mode: "offset", from, distance} | {mode: "midplane", a, b} | {mode: "angle", from, axis, angle}; datum_axis {mode: "edge" | "cylinder" | "planes" | "points", …}; tag {target: <Ref>} names a selection for later ({"op": "tagged", "feature": "<tag id>"}).',
    "",
    "## References (semantic, never indices)",
    'A Ref is {"kind": "face" | "edge" | "vertex" | "body", "q": <query>, "card"?: "one" | "some" | "any" | n}. Queries:',
    '- named sources: {op:"body", feature}; {op:"cap", feature (extrude), end: "start" | "end"}; {op:"endcap", feature (revolve), end}; {op:"side", feature, curve} (the side face swept from a sketch curve, e.g. "outline.left"); {op:"edge_at", feature, curve, end}; {op:"between", a: <face query>, b: <face query>} (their shared edges); {op:"hole_face", feature, at, part: "wall" | "floor" | …}; {op:"tagged", feature};',
    '- sets: {op:"bodies"}; {op:"sides", feature}; {op:"created", feature, role?}; {op:"faces" | "edges" | "vertices" | "owner", of: <query>};',
    '- filters: {op:"filter", of, where: {normal: Dir} (planar faces facing Dir) | {parallel: Dir} (line edges ∥, or faces) | {perpendicular: Dir} | {type: "plane" | "cylinder" | "line" | "circle" | …} | {radius: {eq | min | max}} | {convex: true} | {concave: true}}; {op:"extreme", of, dir, which: "max" | "min"}; {op:"largest" | "smallest", of}; {op:"union" | "intersect", of: [..]}; {op:"minus", a, b}.',
    '- Top face of an extrude: cap end; its vertical edges: filter parallel "Z" of edges of sides; the edges around its top: edges of cap end. Aim every Ref with find_entities first; list_entities gives verified ready-made refs.',
    "",
    "## Worked examples (each call builds)",
    ...OPS_RECIPES.map(recipeText),
  ].join("\n");
}

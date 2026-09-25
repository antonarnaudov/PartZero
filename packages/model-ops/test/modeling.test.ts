/**
 * The modeling tools as commands (`src/modeling`), on the real Forge engine: each tool's arguments
 * become catalogue ops that build — new features and edits of existing ones — through the same
 * transaction the app and the agent use (`MemoryOpsHost`, here as a user and as an agent).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { parseDoc } from "../src/doc.js";
import { CommandEngineError, type IrCommandEngine } from "../src/engine.js";
import { MemoryOpsHost } from "../src/host.js";
import {
  bodyQuery,
  edgeQuery,
  faceDriver,
  faceFrame,
  faceQuery,
  MODELING_TOOLS,
  modelingContextOf,
  modelingTool,
  parseKey,
  runModelingTool,
  toUv,
  vertexQuery,
} from "../src/modeling/index.js";
import { hasWasm, loadEngine, plate } from "./engine.js";

let engine: IrCommandEngine;
beforeAll(async () => {
  if (hasWasm) engine = await loadEngine();
}, 60_000);

const it_ = hasWasm ? it : it.skip;

async function host(document = plate(), origin: "user" | "agent" = "user"): Promise<MemoryOpsHost> {
  return MemoryOpsHost.open({ engine, document, origin });
}

async function run(h: MemoryOpsHost, tool: string, args: Record<string, unknown>) {
  const t = modelingTool(tool);
  if (!t) throw new Error(`no tool ${tool}`);
  return runModelingTool(t, args, h);
}

async function report(h: MemoryOpsHost) {
  return h.report();
}

function feature(doc: string, id: string): Record<string, unknown> {
  return parseDoc(doc).parts.flatMap((p) => p.features).find((f) => f.id === id)!;
}

async function refused(p: Promise<unknown>): Promise<CommandEngineError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CommandEngineError);
    return e as CommandEngineError;
  }
  throw new Error("expected a refusal");
}

const bodies = async (h: MemoryOpsHost) => ((await report(h)).parts ?? []).flatMap((p) => p.bodies);

describe("keys → references", () => {
  const doc = parseDoc(plate({ features: [{ type: "hole", id: "h1", name: "bore", on: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } }, at: { list: [{ id: "a", at: [0, 0] }] }, d: 3, depth: "through" }] }));

  it("parses render names and keys, with escapes, nested keys, qualifiers and display indices", () => {
    expect(parseKey("e1/cap:end")).toMatchObject({ feature: "e1", label: "cap", leaves: ["end"], qualifier: null });
    expect(parseKey("e1/cap:end@r.bottom#1")).toMatchObject({ qualifier: "r.bottom" });
    expect(parseKey("e1/edge:{e1/cap:start|e1/side:r.left}")).toMatchObject({ label: "edge", keys: ["e1/cap:start", "e1/side:r.left"] });
    expect(parseKey("a%2Fb/side:c")).toMatchObject({ feature: "a/b" });
    expect(parseKey("no-slash")).toBeNull();
  });

  it("names faces by their named source: caps, sides, hole faces (by id or by feature name)", () => {
    expect(faceQuery(doc, "e1/cap:end")).toEqual({ op: "cap", feature: "e1", end: "end" });
    expect(faceQuery(doc, "slab/side:r.left")).toEqual({ op: "side", feature: "e1", curve: "r.left" });
    expect(faceQuery(doc, "h1/wall", () => "a")).toEqual({ op: "hole_face", feature: "h1", at: "a", part: "wall" });
    expect(faceQuery(doc, "h1/wall")).toBeNull();
    expect(faceQuery(doc, "e1/body:r.bottom")).toBeNull();
    expect(edgeQuery(doc, "e1/edge:{e1/cap:end|e1/side:r.top}")).toEqual({ op: "between", a: { op: "cap", feature: "e1", end: "end" }, b: { op: "side", feature: "e1", curve: "r.top" } });
    expect(vertexQuery(doc, "vertex:{e1/edge:{e1/cap:end|e1/side:r.top}|e1/edge:{e1/cap:end|e1/side:r.left}}")).toMatchObject({ op: "intersect" });
    expect(bodyQuery(doc, "part/slab", null)).toEqual({ op: "body", feature: "e1" });
    expect(bodyQuery(doc, "e1", null)).toEqual({ op: "body", feature: "e1" });
    expect(bodyQuery(doc, "part/nothing", null)).toBeNull();
  });

  it("computes face frames as SPEC-v1 §3.1 does", () => {
    const top = faceFrame([0, 0, 1], [3, 4, 5])!;
    expect(top).toEqual({ origin: [0, 0, 5], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] });
    expect(toUv(top, [10, -2, 5])).toEqual([10, -2]);
    const front = faceFrame([0, -1, 0], [0, -7, 0])!;
    expect(front.x).toEqual([1, 0, 0]);
    expect(front.y).toEqual([0, 0, 1]);
    const right = faceFrame([1, 0, 0], [9, 0, 0])!;
    expect(right.x).toEqual([0, 1, 0]);
    expect(right.y).toEqual([0, 0, 1]);
  });
});

describe("every modeling tool", () => {
  it("has a unique id and agent tool name, a strict schema and a description", () => {
    const ids = MODELING_TOOLS.map((t) => t.id);
    const names = MODELING_TOOLS.map((t) => t.agentTool);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    for (const t of MODELING_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.args.safeParse({ nonsense: 1 }).success).toBe(false);
    }
  });
});

describe("extrude", () => {
  it_("adds an extrude of a sketch, then edits its distance, direction and operation in place", async () => {
    const h = await host(plate({ features: [{ type: "sketch", id: "s2", name: "bossSk", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 5 }] }] }));
    const { plan, commit } = await run(h, "extrude", { sketch: "bossSk", distance: 12, operation: "join", targets: ["part/slab"] });
    expect(plan).toMatchObject({ adds: true, feature: "extrude1", label: "Extrude bossSk" });
    expect(commit.changed).toBe(true);
    const f = feature(await h.document(), "extrude1");
    expect(f).toMatchObject({ type: "extrude", sketch: "s2", distance: 12, op: "join", targets: { kind: "body", q: { op: "body", feature: "e1" } } });
    const b = await bodies(h);
    expect(b).toHaveLength(1);
    expect(b[0]!.bbox_max[2]).toBeCloseTo(12, 9);

    const edit = await run(h, "extrude", { feature: "extrude1", distance: "t * 3", direction: "symmetric" });
    expect(edit.plan.ops).toEqual([{ op: "updateFeature", feature: "extrude1", set: { distance: "t * 3", direction: "symmetric" } }]);
    expect((await bodies(h))[0]!.bbox_max[2]).toBeCloseTo(7.5, 9);

    // Back to a new body: the targets go with the operation.
    const nb = await run(h, "extrude", { feature: "extrude1", operation: "new_body" });
    expect(nb.plan.ops).toEqual([{ op: "updateFeature", feature: "extrude1", set: { op: null, targets: null } }]);
    expect(await bodies(h)).toHaveLength(2);
  });

  it_("refuses a missing or wrong profile with the field, and the engine's code for a distance that does not build", async () => {
    const h = await host();
    expect(await refused(run(h, "extrude", { distance: 3 }))).toMatchObject({ code: "MODEL_MISSING_ARG", details: { field: "sketch" } });
    expect(await refused(run(h, "extrude", { sketch: "slab" }))).toMatchObject({ code: "MODEL_NOT_A_SKETCH" });
    const e = await refused(run(h, "extrude", { sketch: "s1", distance: 0 }));
    expect(e.code).toMatch(/INVALID_DISTANCE|COMMAND_FEATURE_FAILS/);
  });

  it_("cuts through all, extrudes up to a face, and switches an extrude back to a distance", async () => {
    const h = await host(plate({ features: [{ type: "sketch", id: "s2", name: "bore", plane: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } }, curves: [{ kind: "circle", id: "c", center: [10, 0], radius: 2 }] }] }));
    const cut = await run(h, "extrude", { sketch: "bore", extent: "through_all", direction: "reverse" });
    expect(feature(await h.document(), cut.plan.feature!)).toMatchObject({ extent: "through_all", op: "cut", targets: "all", direction: "reverse" });
    expect(feature(await h.document(), cut.plan.feature!)["distance"]).toBeUndefined();
    expect((await bodies(h))[0]!.volume).toBeCloseTo(40 * 20 * 5 - Math.PI * 4 * 5, 6);
    // The plate gets thicker (t = 9): the through cut still goes through.
    await h.apply([{ op: "setParam", name: "t", value: 9 }]);
    expect((await bodies(h))[0]!.volume).toBeCloseTo(40 * 20 * 9 - Math.PI * 4 * 9, 6);
    // Back to a blind pocket by a distance: the extent goes.
    await run(h, "extrude", { feature: cut.plan.feature!, extent: "distance", distance: 2 });
    const f = feature(await h.document(), cut.plan.feature!);
    expect(f["extent"]).toBeUndefined();
    expect(f["distance"]).toBe(2);
    expect(await refused(run(h, "extrude", { sketch: "bore", extent: "through_all", operation: "join" }))).toMatchObject({ code: "MODEL_INVALID_ARG", details: { field: "extent" } });
    // Up to a datum plane 20 above the plate's bottom (a new body: the pocket under the same
    // circle leaves a join nothing to meet): the body ends on the plane, and follows it.
    await run(h, "datum_plane", { from: "XY", distance: 20 });
    const up = await run(h, "extrude", { sketch: "bore", extent: "up_to", up_to: "datum_plane1" });
    expect(feature(await h.document(), up.plan.feature!)).toMatchObject({ extent: { up_to: { datum: "datum_plane1" } } });
    const top = async () => (await report(h)).parts![0]!.bodies.find((b) => b.origin.feature === up.plan.feature)!;
    expect((await top()).bbox_min[2]).toBeCloseTo(9, 9);
    expect((await top()).bbox_max[2]).toBeCloseTo(20, 9);
    await run(h, "datum_plane", { feature: "datum_plane1", distance: 25 });
    expect((await top()).bbox_max[2]).toBeCloseTo(25, 9);
    expect(await refused(run(h, "push_pull", { face: `${up.plan.feature}/cap:end`, offset: 1 }))).toMatchObject({ code: "MODEL_NO_DRIVER" });
  });

  it_("is the agent's command too: the agent's feature is marked, and it may not edit the user's", async () => {
    const h = await host(plate(), "agent");
    await run(h, "extrude", { sketch: "s1", distance: 2, direction: "reverse", operation: "join" });
    expect(feature(await h.document(), "extrude1")["author"]).toBe("agent");
    expect(await refused(run(h, "extrude", { feature: "slab", distance: 9 }))).toMatchObject({ code: "unapproved_user_change" });
  });
});

describe("revolve", () => {
  const ring = () =>
    plate({
      features: [{ type: "sketch", id: "s2", name: "profile", plane: "XZ", curves: [{ kind: "rect", id: "p", corner: [30, 0], w: 5, h: 10 }, { kind: "line", id: "ax", start: [0, 0], end: [0, 10], construction: true }, { kind: "line", id: "mid", start: [32, -5], end: [32, 20], construction: true }] }],
    });

  it_("revolves about the sketch's v axis, a sketch line, or u, by an angle, and edits the angle", async () => {
    const h = await host(ring());
    const { plan } = await run(h, "revolve", { sketch: "profile", axis: "ax" });
    expect(plan.feature).toBe("revolve1");
    expect(feature(await h.document(), "revolve1")).toMatchObject({ axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
    const b = (await bodies(h)).find((x) => x.origin.feature === "revolve1")!;
    expect(b.volume).toBeCloseTo(Math.PI * (35 * 35 - 30 * 30) * 10, 3);
    await run(h, "revolve", { feature: "revolve1", angle: 90, direction: "symmetric" });
    const q = (await bodies(h)).find((x) => x.origin.feature === "revolve1")!;
    expect(q.volume).toBeCloseTo((Math.PI * (35 * 35 - 30 * 30) * 10) / 4, 3);
  });

  it_("refuses an axis that is not a line of the sketch", async () => {
    const h = await host(ring());
    expect(await refused(run(h, "revolve", { sketch: "profile", axis: "nope" }))).toMatchObject({ code: "MODEL_UNKNOWN_CURVE", details: { field: "axis" } });
    expect(await refused(run(h, "revolve", { sketch: "profile", axis: "mid" }))).toMatchObject({ code: "COMMAND_FEATURE_FAILS" });
  });
});

describe("hole", () => {
  it_("drills at picked world points on a face (u, v from the engine's face frame), then edits it to a counterbore", async () => {
    const h = await host();
    const { plan } = await run(h, "hole", { face: "e1/cap:end", points: [[10, 3, 5], [-10, -3, 5]], size: "M3", depth: "through" });
    expect(plan.feature).toBe("hole1");
    const f = feature(await h.document(), "hole1");
    expect(f).toMatchObject({ on: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } }, at: { list: [{ id: "p1", at: [10, 3] }, { id: "p2", at: [-10, -3] }] }, size: "M3", depth: "through" });
    const r = await report(h);
    const holes = r.features.find((x) => x.feature_id === "hole1")!.holes!;
    expect(holes.map((x) => x.center)).toEqual([
      [10, 3, 5],
      [-10, -3, 5],
    ]);
    expect(holes[0]!.d).toBeCloseTo(3.4, 9);
    await run(h, "hole", { feature: "hole1", kind: "counterbore" });
    expect(feature(await h.document(), "hole1")["cbore"]).toBe("iso4762");
    await run(h, "hole", { feature: "hole1", kind: "simple", size: "M4", fit: "close" });
    const g = feature(await h.document(), "hole1");
    expect(g["cbore"]).toBeUndefined();
    expect(g).toMatchObject({ size: "M4", fit: "close" });
  });

  it_("drills a blind flat-bottomed hole of a custom diameter on a side face, a grid and a bolt circle", async () => {
    const h = await host();
    await run(h, "hole", { face: "e1/side:r.right", points: [[20, 0, 2.5]], diameter: 2, depth: 6, tip: "flat" });
    const f = feature(await h.document(), "hole1");
    expect(f).toMatchObject({ d: 2, depth: { blind: 6 }, tip: "flat" });
    expect(f["size"]).toBeUndefined();
    await run(h, "hole", { face: "e1/cap:end", grid: { nx: 2, ny: 2, dx: 30, dy: 10 }, size: "M2" });
    expect(feature(await h.document(), "hole2")["at"]).toEqual({ grid: { nx: 2, ny: 2, dx: 30, dy: 10 } });
    const r = await report(h);
    expect(r.features.find((x) => x.feature_id === "hole2")!.holes).toHaveLength(4);
  });

  it_("refuses a hole off the face with the engine's code", async () => {
    const h = await host();
    const e = await refused(run(h, "hole", { face: "e1/cap:end", at: [{ u: 50, v: 0 }], size: "M3" }));
    expect(e.code).toBe("COMMAND_FEATURE_FAILS");
    expect(JSON.stringify(e.details)).toContain("HOLE_POINT_OFF_FACE");
  });
});

describe("datum plane and axis", () => {
  it_("offsets from a face, angles about an axis, runs midway between two faces and through three points", async () => {
    const h = await host();
    await run(h, "datum_plane", { from: "e1/cap:end", distance: 4 });
    await run(h, "datum_plane", { mode: "angle", from: "XY", axis: "X", angle: 30 });
    await run(h, "datum_plane", { mode: "midplane", a: "e1/side:r.left", b: "e1/side:r.right" });
    await run(h, "datum_plane", { mode: "three_points", points: [[0, 0, 0], [1, 0, 0], [0, 1, 1]] });
    const r = await report(h);
    const datum = (id: string) => r.features.find((f) => f.feature_id === id)!.datum as { origin: number[]; normal: number[] };
    expect(datum("datum_plane1").origin[2]).toBeCloseTo(9, 9);
    expect(datum("datum_plane2").normal[1]).toBeCloseTo(-0.5, 9);
    expect(datum("datum_plane3").origin[0]).toBeCloseTo(0, 9);
    expect(Math.abs(datum("datum_plane3").normal[0]!)).toBeCloseTo(1, 9);
    expect(datum("datum_plane4").normal[2]).toBeCloseTo(Math.SQRT1_2, 9);
    await run(h, "datum_plane", { feature: "datum_plane1", distance: 1 });
    expect(((await report(h)).features.find((f) => f.feature_id === "datum_plane1")!.datum as { origin: number[] }).origin[2]).toBeCloseTo(6, 9);
  });

  it_("makes axes along an edge, through two planes and two points", async () => {
    const h = await host();
    await run(h, "datum_axis", { edge: "e1/edge:{e1/cap:end|e1/side:r.top}" });
    await run(h, "datum_axis", { mode: "planes", a: "XZ", b: "YZ" });
    await run(h, "datum_axis", { points: [[0, 0, 0], [0, 0, 5]], flip: true });
    const r = await report(h);
    const axis = (id: string) => r.features.find((f) => f.feature_id === id)!.datum as { origin: number[]; direction: number[] };
    expect(axis("datum_axis1").direction).toEqual([1, 0, 0]);
    expect(axis("datum_axis1").origin).toEqual([0, 10, 5]);
    expect(Math.abs(axis("datum_axis2").direction[2]!)).toBeCloseTo(1, 9);
    expect(axis("datum_axis3").direction[2]).toBeCloseTo(-1, 9);
  });

  it_("refuses a plane that is not planar (a curved face) with the engine's code", async () => {
    const h = await host(plate({ features: [{ type: "sketch", id: "s2", name: "c", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 30], radius: 5 }] }, { type: "extrude", id: "e2", name: "peg", sketch: "s2", distance: 3 }] }));
    const e = await refused(run(h, "datum_plane", { from: "e2/side:c", distance: 1 }));
    expect(JSON.stringify(e.details)).toContain("PLANE_NOT_PLANAR");
  });
});

describe("combine", () => {
  it_("joins and cuts bodies by the names the viewport shows", async () => {
    const two = plate({
      features: [
        { type: "sketch", id: "s2", name: "pegSk", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 4 }] },
        { type: "extrude", id: "e2", name: "peg", sketch: "s2", distance: 12 },
      ],
    });
    const h = await host(two);
    expect(await bodies(h)).toHaveLength(2);
    const { plan } = await run(h, "combine", { operation: "cut", targets: ["part/slab"], tools: ["part/peg"] });
    expect(plan.label).toBe("Cut bodies");
    const b = await bodies(h);
    expect(b).toHaveLength(1);
    expect(b[0]!.volume).toBeCloseTo(40 * 20 * 5 - Math.PI * 16 * 5, 3);
    await run(h, "combine", { feature: "boolean1", operation: "join", keep_tools: false });
    expect((await bodies(h))[0]!.volume).toBeCloseTo(40 * 20 * 5 + Math.PI * 16 * 7, 3);
  });
});

describe("move/copy (transform, SPEC-v1 §6.13)", () => {
  it_("moves a body (a later hole on its cap follows), copies it rotated, and edits the angle", async () => {
    // A hole placed where the slab will be after the move (it fails until then).
    const h = await host(plate({ features: [{ type: "hole", id: "h1", name: "bore", on: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } }, at: { list: [{ id: "a", at: [50, 0] }] }, d: 3, depth: "through" }] }));
    expect((await report(h)).features.find((f) => f.feature_id === "h1")!.error?.code).toBe("HOLE_POINT_OFF_FACE");
    const moved = await runModelingTool(modelingTool("move")!, { bodies: ["part/slab"], translate: [50, 0, 0] }, h);
    expect(moved.plan).toMatchObject({ adds: true, feature: "transform1", label: "Move bodies" });
    // Reordered before the hole: the hole's face reference follows the moved cap (keys kept).
    await h.apply([{ op: "moveFeature", feature: "transform1", after: "e1" }]);
    let r = await report(h);
    expect(r.status).toBe("ok");
    expect(r.features.find((f) => f.feature_id === "h1")!.holes![0]!.center).toEqual([50, 0, 5]);
    expect(r.parts![0]!.bodies[0]!.bbox_min[0]).toBeCloseTo(30, 9);
    const copy = await run(h, "move", { bodies: ["part/slab"], rotate: { axis: "Z", angle: 90 }, copy: true });
    expect(feature(await h.document(), copy.plan.feature!)).toMatchObject({ type: "transform", rotate: { axis: "Z", angle: 90 }, copy: true });
    r = await report(h);
    expect(r.parts![0]!.bodies).toHaveLength(2);
    await run(h, "move", { feature: copy.plan.feature!, rotate_angle: 45 });
    expect((feature(await h.document(), copy.plan.feature!)["rotate"] as { angle: number }).angle).toBe(45);
    expect(await refused(run(h, "move", { bodies: ["part/slab"] }))).toMatchObject({ code: "MODEL_MISSING_ARG" });
  });
});

describe("push/pull", () => {
  it_("pulls an extrude's end cap (its distance), a parameter that drives it, and a pocket floor", async () => {
    const h = await host(plate({ features: [{ type: "sketch", id: "s2", name: "pk", plane: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } }, curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 3 }] }, { type: "extrude", id: "e2", name: "pocket", sketch: "s2", distance: 2, direction: "reverse", op: "cut", targets: "all" }] }));
    // e1's distance is the parameter t (5): pulling the top up by 1 sets t = 6.
    const t = await run(h, "push_pull", { face: "e1/cap:end", offset: 1 });
    expect(t.plan.ops).toEqual([{ op: "setParam", name: "t", value: 6 }]);
    // The pocket floor pulled out by 0.5 (into the pocket): the cut gets shallower.
    const p = await run(h, "push_pull", { face: "e2/cap:end", offset: 0.5 });
    expect(p.plan.ops).toEqual([{ op: "updateFeature", feature: "e2", set: { distance: 1.5 } }]);
    await run(h, "push_pull", { face: "e2/cap:end", value: "t / 2" });
    expect(feature(await h.document(), "e2")["distance"]).toBe("t / 2");
  });

  it_("refuses faces nothing drives, saying what to edit", async () => {
    const h = await host();
    const ctx = await modelingContextOf(h);
    const doc = parseDoc(ctx.document);
    expect(faceDriver(doc, "e1/cap:end")).toMatchObject({ field: "distance", factor: 1 });
    expect(await refused(run(h, "push_pull", { face: "e1/side:r.left", offset: 1 }))).toMatchObject({ code: "MODEL_NO_DRIVER" });
    expect(await refused(run(h, "push_pull", { face: "e1/cap:start", offset: 1 }))).toMatchObject({ code: "MODEL_NO_DRIVER" });
  });
});

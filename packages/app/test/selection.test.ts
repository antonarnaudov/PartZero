import { describe, expect, it } from "vitest";
import { parseObj } from "../src/engine/obj";
import { boxKind, boxModeOf, boxSelect, segmentRect } from "../src/selection/box-select";
import { labelOf } from "../src/selection/labels";
import { facesOfEdgeName, nearbyVertices, pickItem, type RawHit } from "../src/selection/picking";
import { raycast } from "../src/selection/raycast";
import { resolveItem, SelectionStore } from "../src/selection/store";
import { buildTopology, vertexKey } from "../src/selection/topology";
import { ALL_KINDS, itemId, type KindMask, type SelectionItem } from "../src/selection/types";
import { cameraFrame, defaultCamera, fitSphere, viewAngles, type CameraState, type Vec3 } from "../src/viewport/view-camera";
import nemaObj from "./fixtures/nema17-plate.obj?raw";

const bodies = parseObj(nemaObj);
const topo = buildTopology(bodies);
const BODY = "plate/plate";
const W = 900;
const H = 700;

function camera(view: "iso" | "top" | "front" = "iso", projection: CameraState["projection"] = "perspective"): CameraState {
  const [yaw, pitch] = viewAngles(view);
  return fitSphere({ ...defaultCamera(), yaw, pitch, projection }, { center: [0, 0, 2.5], radius: Math.hypot(25, 25, 2.5) }, W / H);
}

/** A fake GPU pick: the CPU ray cast (faces only), like forge-render without edge snapping. */
function fakePick(frame: ReturnType<typeof cameraFrame>): (x: number, y: number) => Promise<RawHit | null> {
  return (x, y) => {
    const { origin, dir } = frame.ray(x, y);
    const h = raycast(topo, origin, dir);
    return Promise.resolve(h ? { kind: "face", body: h.body, face: h.face, point: h.point } : null);
  };
}

const only = (k: keyof KindMask): KindMask => ({ vertex: false, edge: false, face: false, body: false, sketch: false, datum: false, origin: false, [k]: true });

describe("scene topology", () => {
  it("derives B-rep vertices from open edge end points (seam-free circles have none)", () => {
    const b = topo.bodies.get(BODY)!;
    expect(b.faces.size).toBe(11);
    expect(b.edges.size).toBe(22);
    // A 50×50×5 plate with holes: 8 corners, the hole circles are closed edges without vertices.
    expect(b.vertices.size).toBe(8);
    const corner = [...b.vertices.values()].find((v) => v.point[0] === 25 && v.point[1] === 25 && v.point[2] === 5)!;
    expect(corner.edges).toHaveLength(3);
    expect(corner.key).toBe(vertexKey(corner.edges));
    expect(corner.key).toBe("vertex:{plate/edge:{plate/cap:end|plate/side:right}|plate/edge:{plate/cap:end|plate/side:top}|plate/edge:{plate/side:right|plate/side:top}}");
    expect(b.edges.get("plate/edge:{plate/cap:end|plate/side:pilot}")!.closed).toBe(true);
  });

  it("parses the face names out of edge names, nested braces included", () => {
    expect(facesOfEdgeName("plate/edge:{plate/cap:end|plate/side:top}")).toEqual(["plate/cap:end", "plate/side:top"]);
    expect(facesOfEdgeName("g/edge:{a/blend:{x/edge:{p|q}}|b/side:c}")).toEqual(["a/blend:{x/edge:{p|q}}", "b/side:c"]);
    expect(facesOfEdgeName("plate/cap:end")).toEqual([]);
  });

  it("labels entities for people and the agent", () => {
    expect(labelOf({ kind: "face", body: BODY, key: "plate/cap:end" })).toBe("End cap of plate");
    expect(labelOf({ kind: "face", body: BODY, key: "plate/side:pilot" })).toBe("Side pilot of plate");
    expect(labelOf({ kind: "edge", body: BODY, key: "plate/edge:{plate/cap:end|plate/side:top}" })).toBe("Edge: end cap / side top (plate)");
    expect(labelOf({ kind: "vertex", body: BODY, key: "k", point: [25, -25, 5] })).toBe("Vertex of plate (25, -25, 5)");
    expect(labelOf({ kind: "origin", id: "XY" })).toBe("XY plane");
  });
});

describe("chat chips from the selection", () => {
  it("gives the primary's feature, then one chip per face, edge and body, with human labels", async () => {
    const { selectionChips } = await import("../src/selection/chips");
    const ir = { parts: [{ name: "plate", features: [{ id: "f2", name: "plate", type: "extrude" }] }] } as never;
    const chips = selectionChips(
      [
        { kind: "face", body: BODY, key: "plate/cap:end" },
        { kind: "edge", body: BODY, key: "plate/edge:{plate/cap:end|plate/side:top}" },
        { kind: "vertex", body: BODY, key: "v", point: [0, 0, 0] },
        { kind: "body", body: BODY },
      ],
      { featureId: "f2", entity: null },
      ir,
    );
    expect(chips).toEqual([
      { kind: "feature", ref: "f2", label: "plate" },
      { kind: "face", ref: "plate/cap:end", label: "End cap of plate" },
      { kind: "edge", ref: "plate/edge:{plate/cap:end|plate/side:top}", label: "Edge: end cap / side top (plate)" },
      { kind: "body", ref: BODY, label: "Body plate" },
    ]);
    // Without model items, the document's own pick is used.
    expect(selectionChips([], { featureId: null, entity: { body: BODY, edge: "e" } }, ir)).toEqual([{ kind: "edge", ref: "e", label: "e" }]);
  });
});

describe("selection store", () => {
  it("keeps order and uniqueness, toggles, and reports the primary", () => {
    const s = new SelectionStore();
    const a: SelectionItem = { kind: "face", body: BODY, key: "plate/cap:end" };
    const b: SelectionItem = { kind: "edge", body: BODY, key: "plate/edge:{plate/cap:end|plate/side:top}" };
    s.set([a, a, b]);
    expect(s.items.map(itemId)).toEqual([itemId(a), itemId(b)]);
    expect(s.primary).toEqual(a);
    const rev = s.getState().revision;
    expect(s.toggle(a)).toBe(false);
    expect(s.items).toEqual([b]);
    expect(s.toggle(a)).toBe(true);
    expect(s.items.map(itemId)).toEqual([itemId(b), itemId(a)]);
    expect(s.getState().revision).toBeGreaterThan(rev);
    s.set([b, a]);
    const r2 = s.getState().revision;
    s.set([b, a]);
    expect(s.getState().revision).toBe(r2);
  });

  it("deselects what a new filter excludes; solo keys pick one kind", () => {
    const s = new SelectionStore();
    s.set([
      { kind: "face", body: BODY, key: "plate/cap:end" },
      { kind: "edge", body: BODY, key: "plate/edge:{plate/cap:end|plate/side:top}" },
    ]);
    s.setFilter({ edge: false });
    expect(s.items.map((i) => i.kind)).toEqual(["face"]);
    const f = s.solo("vertex");
    expect(f.vertex && !f.face && !f.edge).toBe(true);
    expect(s.items).toEqual([]);
    expect(s.solo("all")).toEqual(ALL_KINDS);
  });

  it("re-resolves after a regeneration: keeps what exists, finds moved vertex keys by position, drops the rest", () => {
    const s = new SelectionStore();
    const v = [...topo.bodies.get(BODY)!.vertices.values()][0]!;
    s.set([
      { kind: "face", body: BODY, key: "plate/cap:end" },
      { kind: "face", body: BODY, key: "plate/side:gone" },
      { kind: "vertex", body: BODY, key: "vertex:{stale}", point: v.point },
    ]);
    const dropped = s.resolve(topo);
    expect(dropped.map(itemId)).toEqual([itemId({ kind: "face", body: BODY, key: "plate/side:gone" })]);
    expect(s.items.map((i) => (i.kind === "vertex" ? i.key : i.kind))).toEqual(["face", v.key]);
    expect(s.getState().dropped).toHaveLength(1);
    expect(resolveItem(topo, { kind: "body", body: "nope" })).toBeNull();
  });
});

describe("picking with the kind filter", () => {
  const frame = cameraFrame(camera("iso"), W, H);
  const pick = fakePick(frame);
  const ctx = (filter: KindMask) => ({ pick, frame, topo, filter });

  it("picks the face under the cursor, or its body with the body filter", async () => {
    const c = frame.project([0, 18, 5])!;
    expect(await pickItem(ctx(ALL_KINDS), c.x, c.y)).toMatchObject({ kind: "face", body: BODY, key: "plate/cap:end" });
    expect(await pickItem(ctx(only("body")), c.x, c.y)).toEqual({ kind: "body", body: BODY });
    expect(await pickItem(ctx(only("edge")), c.x, c.y)).toBeNull();
  });

  it("picks a visible vertex near the cursor and never a hidden one", async () => {
    const top = frame.project([25, 25, 5])!;
    const got = await pickItem(ctx(ALL_KINDS), top.x + 3, top.y + 2);
    expect(got).toMatchObject({ kind: "vertex", body: BODY, point: [25, 25, 5] });
    // The bottom-back corner (−25, 25, 0) is behind the plate in iso: not pickable as a vertex.
    const hidden = frame.project([-25, 25, 0])!;
    const near = nearbyVertices({ frame, topo }, hidden.x, hidden.y);
    expect(near[0]!.vertex.point).toEqual([-25, 25, 0]);
    const at = await pickItem(ctx(only("vertex")), hidden.x, hidden.y);
    expect(at === null || (at.kind === "vertex" && at.point![2] === 5)).toBe(true);
  });

  it("replaces an excluded edge snap with the face under the cursor", async () => {
    const c = frame.project([0, 18, 5])!;
    const edgeSnap = (): Promise<RawHit> => Promise.resolve({ kind: "edge", body: BODY, edge: "plate/edge:{plate/cap:end|plate/side:top}", point: [0, 25, 5] });
    const noEdges: KindMask = { ...ALL_KINDS, edge: false, vertex: false };
    expect(await pickItem({ ...ctx(noEdges), pick: edgeSnap }, c.x, c.y)).toMatchObject({ kind: "face", key: "plate/cap:end" });
    expect(await pickItem({ ...ctx(ALL_KINDS), pick: edgeSnap }, c.x, c.y)).toMatchObject({ kind: "edge" });
  });
});

describe("box selection", () => {
  it("drag direction picks window (left→right) or crossing (right→left)", () => {
    expect(boxModeOf(10, 50)).toBe("window");
    expect(boxModeOf(50, 10)).toBe("crossing");
    expect(boxKind(ALL_KINDS)).toBe("face");
    expect(boxKind(only("edge"))).toBe("edge");
    expect(boxKind({ ...only("body") })).toBe("body");
    expect(segmentRect({ x0: 0, y0: 0, x1: 10, y1: 10 }, -5, 5, 15, 5)).not.toBeNull();
    expect(segmentRect({ x0: 0, y0: 0, x1: 10, y1: 10 }, -5, -5, -1, 20)).toBeNull();
  });

  it("window-selects the visible faces fully inside, never the hidden bottom face", () => {
    const frame = cameraFrame(camera("iso"), W, H);
    const all = boxSelect({ frame, topo, filter: ALL_KINDS, rect: { x0: 0, y0: 0, x1: W, y1: H }, mode: "window" });
    const keys = all.map((i) => (i.kind === "face" ? i.key : ""));
    expect(keys).toContain("plate/cap:end");
    expect(keys).toContain("plate/side:bottom");
    expect(keys).toContain("plate/side:right");
    // Hidden from the iso view: the bottom cap and the back sides.
    expect(keys).not.toContain("plate/cap:start");
    expect(keys).not.toContain("plate/side:top");
    expect(keys).not.toContain("plate/side:left");
    const withHidden = boxSelect({ frame, topo, filter: ALL_KINDS, rect: { x0: 0, y0: 0, x1: W, y1: H }, mode: "window", includeHidden: true });
    expect(withHidden).toHaveLength(11);
  });

  it("crossing selects what the box touches; window needs the whole entity", () => {
    const frame = cameraFrame(camera("top", "orthographic"), W, H);
    const c = frame.project([15.5, 15.5, 5])!;
    // A small box around the m3_a hole centre: it touches the hole wall's rim but contains no whole face.
    const r = { x0: c.x - 3, y0: c.y - 3, x1: c.x + 3, y1: c.y + 3 };
    expect(boxSelect({ frame, topo, filter: ALL_KINDS, rect: r, mode: "window" })).toEqual([]);
    const half = frame.project([15.5 + 3, 15.5, 5])!.x - c.x;
    const around = { x0: c.x - half, y0: c.y - half, x1: c.x + half, y1: c.y + half };
    const edges = boxSelect({ frame, topo, filter: only("edge"), rect: around, mode: "window" }).map((i) => (i.kind === "edge" ? i.key : ""));
    // Looking straight down the through hole, both rims are on its outline; nothing else is inside.
    expect(edges).toContain("plate/edge:{plate/cap:end|plate/side:m3_a}");
    expect(edges.every((e) => e.endsWith("side:m3_a}"))).toBe(true);
    const cross = boxSelect({ frame, topo, filter: ALL_KINDS, rect: { x0: c.x + 20, y0: c.y - 1, x1: c.x + 60, y1: c.y + 1 }, mode: "crossing" });
    expect(cross.map((i) => (i.kind === "face" ? i.key : ""))).toEqual(["plate/cap:end"]);
  });

  it("selects vertices and bodies by box", () => {
    const frame = cameraFrame(camera("iso"), W, H);
    const vs = boxSelect({ frame, topo, filter: only("vertex"), rect: { x0: 0, y0: 0, x1: W, y1: H }, mode: "window" });
    // 8 corners, 7 visible from the iso direction.
    expect(vs).toHaveLength(7);
    const bs = boxSelect({ frame, topo, filter: only("body"), rect: { x0: 0, y0: 0, x1: W, y1: H }, mode: "window" });
    expect(bs).toEqual([{ kind: "body", body: BODY }]);
    const p = frame.project([0, 0, 5] as Vec3)!;
    expect(boxSelect({ frame, topo, filter: only("body"), rect: { x0: p.x - 2, y0: p.y - 2, x1: p.x + 2, y1: p.y + 2 }, mode: "window" })).toEqual([]);
  });
});

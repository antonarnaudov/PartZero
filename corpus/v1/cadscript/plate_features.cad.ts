import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ, param, point, rect, hole, grid, boltCircle, fillet, chamfer, linearPattern, circularPattern, mirror, datumPlane, datumAxis, tag, edgesBetween, min, X, Z } from "@aicad/std";

doc({ name: "plate_features", description: "SPEC-v1 §5.11, §6.2, §6.5, §6.6, §6.7, §6.10, §6.12 examples on one plate: sketch on a tagged face, join boss, four hole kinds, fillets, chamfer, patterns, datums" });

const width = param(80, { min: 20, max: 300, note: "outer width" });
const depth = param(50);
const thick = param(8, { min: 2 });
const holes = param(4, { unit: "count", min: 1 });

part("plate");
const margin = param(min(width, depth) / 8);
const base = sketch(XY, {
  outline: rect({ center: [0, 0], w: width, h: depth, r: 4 }),
});
const slab = extrude(base, { distance: thick });
const topFace = tag(slab.body().faces().normal("+Z").one());
const bossSk = sketch(topFace, {
  ring: circle({ center: [0, 0], radius: 11 }),
  p1: point([4, 0]),
  p2: point([-4, 0]),
});
const boss = extrude(bossSk, { distance: 12, op: "join", targets: slab });
const mounts = hole(slab.cap("end"), { at: grid({ nx: 2, ny: 2, dx: width - 2 * margin, dy: depth - 2 * margin }), size: "M5", depth: "through", cbore: "iso4762" });
const inserts = hole(boss.cap("end"), { at: bossSk.points("p1", "p2"), size: "M3", insert: "std" });
const pilots = hole(slab.cap("end"), { at: { a: [30, -18], b: [-30, -18] }, d: 3.4, depth: { blind: 6 }, tip: "flat" });
const bolts = hole(slab.cap("start"), { at: boltCircle({ n: 3, d: 20, start: 90 }), size: "M4", fit: "close", depth: "through", csink: "iso10642", flip: true });
const tapped = hole(slab.cap("end"), { at: { t: [0, -18] }, size: "M3", depth: { blind: 6 }, thread: { depth: 5 } });
const corners = fillet(slab.sides().edges().parallel(Z), { r: 1 });
const rootRing = fillet(edgesBetween(boss.side("ring"), slab.cap("end")), { r: 2 });
const topEdge = chamfer(boss.cap("end").edges(), { d: 1 });
const bossRow = linearPattern([boss, inserts], { dir: X, count: holes, spacing: 20 });
const mid = datumPlane({ midplane: [slab.side("outline.left"), slab.side("outline.right")] });
const otherSide = mirror([pilots], { plane: mid });
const bossAxis = datumAxis({ cylinder: boss.side("ring") });
const pilotRing = circularPattern([tapped], { axis: bossAxis, count: 6, skip: [[3]] });

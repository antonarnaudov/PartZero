// expect: fail — the chamfers come from intersecting two chamfered profiles, not from the chamfer feature the prompt asks for: the part is right, only chamfers (blend_edges) fails
import { doc, part, sketch, extrude, line, hole, XZ, YZ } from "@aicad/std";

doc({ name: "chamfered_spacer_block", description: "30x30x12 spacer: two chamfered 30x12 profiles intersected, M6 clearance hole" });

part("spacer");
const front = sketch(XZ, {
  b: line([-14, 0], [14, 0]),
  br: line([14, 0], [15, 1]),
  r: line([15, 1], [15, 11]),
  tr: line([15, 11], [14, 12]),
  t: line([14, 12], [-14, 12]),
  tl: line([-14, 12], [-15, 11]),
  l: line([-15, 11], [-15, 1]),
  bl: line([-15, 1], [-14, 0]),
});
const barX = extrude(front, { distance: 30, direction: "symmetric" });
const side = sketch(YZ, {
  b: line([-14, 0], [14, 0]),
  br: line([14, 0], [15, 1]),
  r: line([15, 1], [15, 11]),
  tr: line([15, 11], [14, 12]),
  t: line([14, 12], [-14, 12]),
  tl: line([-14, 12], [-15, 11]),
  l: line([-15, 11], [-15, 1]),
  bl: line([-15, 1], [-14, 0]),
});
const spacer = extrude(side, { distance: 30, direction: "symmetric", op: "intersect", targets: barX });
const bolt = hole(barX.side("t"), { at: { m6: [0, 0] }, size: "M6", depth: "through" });

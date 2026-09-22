import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";

doc({ name: "revolve_partial_ring", description: "Offset rectangle revolved 90 deg -> quarter ring with planar end caps" });

part("part");
const profile = sketch(XZ, {
  inner: line([20, 0], [20, 6]),
  top: line([20, 6], [32, 6]),
  outer: line([32, 6], [32, 0]),
  bottom: line([32, 0], [20, 0]),
});
const quarter = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 90 });

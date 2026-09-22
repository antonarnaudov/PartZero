import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";

doc({ name: "revolve_solid_cylinder", description: "Rectangle touching the axis revolved 360 -> solid cylinder r=10 h=30" });

part("part");
const profile = sketch(XZ, {
  base: line([0, 0], [10, 0]),
  wall: line([10, 0], [10, 30]),
  lid: line([10, 30], [0, 30]),
  axis_edge: line([0, 30], [0, 0]),
});
const rod = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";

doc({ name: "revolve_cone_sphere", description: "Profile with slanted line (cone) and quarter arc touching axis (sphere cap) revolved 360" });

part("part");
const profile = sketch(XZ, {
  axis_seg: line([0, -10], [0, 20]),
  cone: line([0, 20], [10, 0]),
  cap: arc({ start: [10, 0], end: [0, -10], center: [0, 0], ccw: false }),
});
const spinner = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

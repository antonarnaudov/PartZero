import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "jar_with_lid", description: "50x40 jar (2 mm wall and floor) and a press-fit lid with a 45.6 mm plug ring, side by side" });

part("jar");
const jar_profile = sketch(XZ, {
  bottom: line([0, 0], [25, 0]),
  outer: line([25, 0], [25, 40]),
  rim: line([25, 40], [23, 40]),
  inner: line([23, 40], [23, 2]),
  floor: line([23, 2], [0, 2]),
  axis_edge: line([0, 2], [0, 0]),
});
const jar = revolve(jar_profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

part("lid");
// Revolved about the vertical line x = 60.
const lid_profile = sketch(XZ, {
  bottom: line([60, 0], [85, 0]),
  edge: line([85, 0], [85, 2]),
  top_outer: line([85, 2], [82.8, 2]),
  plug_outer: line([82.8, 2], [82.8, 7]),
  plug_top: line([82.8, 7], [81.3, 7]),
  plug_inner: line([81.3, 7], [81.3, 2]),
  top_inner: line([81.3, 2], [60, 2]),
  axis_edge: line([60, 2], [60, 0]),
});
const lid = revolve(lid_profile, { axis: { origin: [60, 0], direction: [0, 1] }, angle: 360 });

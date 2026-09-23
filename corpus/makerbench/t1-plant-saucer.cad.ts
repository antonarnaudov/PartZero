import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "plant_saucer", description: "Plant saucer: 120 mm rim, 100 mm base, 15 tall, 3 mm floor, 2 mm sloped wall" });

part("saucer");
// Outer wall from r = 50 at the bottom to r = 60 at the top; the inner wall is 2 mm further in
// (measured horizontally), so it meets the 3 mm floor at r = 48 + 10 * 3 / 15 = 50.
const profile = sketch(XZ, {
  bottom: line([0, 0], [50, 0]),
  outer_wall: line([50, 0], [60, 15]),
  rim: line([60, 15], [58, 15]),
  inner_wall: line([58, 15], [50, 3]),
  floor: line([50, 3], [0, 3]),
  axis_edge: line([0, 3], [0, 0]),
});
const saucer = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

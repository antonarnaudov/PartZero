import { doc, part, sketch, line, circle, extrude, revolve, XY, XZ } from "@aicad/std";

doc({ name: "spool_holder", description: "Spool holder: 60x60x5 base with 4x M4 holes on 50 mm square, 30x80 spindle with 2 mm top chamfer" });

part("holder");
const base_outline = sketch(XY, {
  bottom: line([-30, -30], [30, -30]),
  right: line([30, -30], [30, 30]),
  top: line([30, 30], [-30, 30]),
  left: line([-30, 30], [-30, -30]),
  m4_a: circle({ center: [25, 25], radius: 2.25 }),
  m4_b: circle({ center: [-25, 25], radius: 2.25 }),
  m4_c: circle({ center: [-25, -25], radius: 2.25 }),
  m4_d: circle({ center: [25, -25], radius: 2.25 }),
});
const base = extrude(base_outline, { distance: 5 });
const spindle_profile = sketch(XZ, {
  foot: line([0, 5], [15, 5]),
  side: line([15, 5], [15, 83]),
  chamfer: line([15, 83], [13, 85]),
  top: line([13, 85], [0, 85]),
  axis_edge: line([0, 85], [0, 5]),
});
const spindle = revolve(spindle_profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

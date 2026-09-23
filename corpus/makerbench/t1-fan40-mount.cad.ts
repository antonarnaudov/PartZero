import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "fan40_mount", description: "40 mm fan mounting plate: 40x40x3, 38 mm air hole, 4x M3 clearance on 32 mm square" });

part("plate");
const outline = sketch(XY, {
  bottom: line([-20, -20], [20, -20]),
  right: line([20, -20], [20, 20]),
  top: line([20, 20], [-20, 20]),
  left: line([-20, 20], [-20, -20]),
  air: circle({ center: [0, 0], radius: 19 }),
  m3_a: circle({ center: [16, 16], radius: 1.7 }),
  m3_b: circle({ center: [-16, 16], radius: 1.7 }),
  m3_c: circle({ center: [-16, -16], radius: 1.7 }),
  m3_d: circle({ center: [16, -16], radius: 1.7 }),
});
const plate = extrude(outline, { distance: 3 });

import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "nema17_plate", description: "NEMA 17 mounting plate: 50x50x5, 22 mm pilot, 4x M3 clearance on 31 mm square" });

part("plate");
const outline = sketch(XY, {
  bottom: line([-25, -25], [25, -25]),
  right: line([25, -25], [25, 25]),
  top: line([25, 25], [-25, 25]),
  left: line([-25, 25], [-25, -25]),
  pilot: circle({ center: [0, 0], radius: 11 }),
  m3_a: circle({ center: [15.5, 15.5], radius: 1.7 }),
  m3_b: circle({ center: [-15.5, 15.5], radius: 1.7 }),
  m3_c: circle({ center: [-15.5, -15.5], radius: 1.7 }),
  m3_d: circle({ center: [15.5, -15.5], radius: 1.7 }),
});
const plate = extrude(outline, { distance: 5 });

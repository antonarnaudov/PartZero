import { doc, part, sketch, line, circle, extrude, XY, XZ } from "@aicad/std";

doc({ name: "nema17_l_bracket", description: "L bracket for a NEMA 17 with a horizontal shaft: 50x45x5 base, 50x50x5 upright face plate" });

part("bracket");
// Back edge on the X axis (y = 0); the base extends toward +Y.
const base_outline = sketch(XY, {
  back: line([-25, 0], [25, 0]),
  right: line([25, 0], [25, 45]),
  front: line([25, 45], [-25, 45]),
  left: line([-25, 45], [-25, 0]),
  m5_l: circle({ center: [-15, 30], radius: 2.75 }),
  m5_r: circle({ center: [15, 30], radius: 2.75 }),
});
const base = extrude(base_outline, { distance: 5 });
// Face plate in XZ (u = x, v = z) standing on the base; XZ's normal is -Y, so "reverse" goes to +Y.
const face_outline = sketch(XZ, {
  bottom: line([-25, 5], [25, 5]),
  right: line([25, 5], [25, 55]),
  top: line([25, 55], [-25, 55]),
  left: line([-25, 55], [-25, 5]),
  pilot: circle({ center: [0, 30], radius: 11 }),
  m3_a: circle({ center: [15.5, 45.5], radius: 1.7 }),
  m3_b: circle({ center: [-15.5, 45.5], radius: 1.7 }),
  m3_c: circle({ center: [-15.5, 14.5], radius: 1.7 }),
  m3_d: circle({ center: [15.5, 14.5], radius: 1.7 }),
});
const face = extrude(face_outline, { distance: 5, direction: "reverse" });

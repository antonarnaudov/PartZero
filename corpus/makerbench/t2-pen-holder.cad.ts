import { doc, part, sketch, line, circle, extrude, frame, XY } from "@aicad/std";

doc({ name: "pen_holder", description: "80x40x3 base with two 30 mm cups (2 mm wall, 60 tall) standing on it" });

part("holder");
const base_outline = sketch(XY, {
  bottom: line([0, 0], [80, 0]),
  right: line([80, 0], [80, 40]),
  top: line([80, 40], [0, 40]),
  left: line([0, 40], [0, 0]),
});
const base = extrude(base_outline, { distance: 3 });
const cup_rings = sketch(frame({ origin: [0, 0, 3], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  cup1_outer: circle({ center: [20, 20], radius: 15 }),
  cup1_inner: circle({ center: [20, 20], radius: 13 }),
  cup2_outer: circle({ center: [60, 20], radius: 15 }),
  cup2_inner: circle({ center: [60, 20], radius: 13 }),
});
const cups = extrude(cup_rings, { distance: 60 });

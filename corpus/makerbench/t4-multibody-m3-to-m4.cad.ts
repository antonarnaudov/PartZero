import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "cable_clamp", description: "Two-part cable clamp, side by side: 80x30x5 base (4x M4, 8 mm cable hole) and an 80x15x4 strap (2x M4)" });

part("base");
const base_outline = sketch(XY, {
  bottom: line([-40, -15], [40, -15]),
  right: line([40, -15], [40, 15]),
  top: line([40, 15], [-40, 15]),
  left: line([-40, 15], [-40, -15]),
  // Front pair screws the base to the wall; back pair takes the strap.
  wall_l: circle({ center: [-33, -8], radius: 2.25 }),
  wall_r: circle({ center: [33, -8], radius: 2.25 }),
  strap_l: circle({ center: [-33, 8], radius: 2.25 }),
  strap_r: circle({ center: [33, 8], radius: 2.25 }),
  cable: circle({ center: [0, 0], radius: 4 }),
});
const base = extrude(base_outline, { distance: 5 });

part("strap");
const strap_outline = sketch(XY, {
  s_bottom: line([-40, 25], [40, 25]),
  s_right: line([40, 25], [40, 40]),
  s_top: line([40, 40], [-40, 40]),
  s_left: line([-40, 40], [-40, 25]),
  screw_l: circle({ center: [-33, 32.5], radius: 2.25 }),
  screw_r: circle({ center: [33, 32.5], radius: 2.25 }),
});
const strap = extrude(strap_outline, { distance: 4 });

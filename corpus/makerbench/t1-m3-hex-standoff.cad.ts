import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "m3_hex_standoff", description: "Hex standoff: 5.5 mm across flats, 12 mm tall, 2.5 mm tap hole" });

part("standoff");
// Regular hexagon, flats parallel to X: circumradius = 2.75 / cos(30°) = 3.1754264805.
const hex = sketch(XY, {
  e1: line([3.1754264805429413, 0], [1.5877132402714706, 2.75]),
  e2: line([1.5877132402714706, 2.75], [-1.5877132402714706, 2.75]),
  e3: line([-1.5877132402714706, 2.75], [-3.1754264805429413, 0]),
  e4: line([-3.1754264805429413, 0], [-1.5877132402714706, -2.75]),
  e5: line([-1.5877132402714706, -2.75], [1.5877132402714706, -2.75]),
  e6: line([1.5877132402714706, -2.75], [3.1754264805429413, 0]),
  tap_hole: circle({ center: [0, 0], radius: 1.25 }),
});
const standoff = extrude(hex, { distance: 12 });

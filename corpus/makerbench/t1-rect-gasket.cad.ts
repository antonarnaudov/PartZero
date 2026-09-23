import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "rect_gasket", description: "Junction box gasket: 90x70 outside, 8 mm band, 4x M3 clearance, 1.5 mm sheet" });

part("gasket");
const outline = sketch(XY, {
  o_bottom: line([-45, -35], [45, -35]),
  o_right: line([45, -35], [45, 35]),
  o_top: line([45, 35], [-45, 35]),
  o_left: line([-45, 35], [-45, -35]),
  i_bottom: line([-37, -27], [37, -27]),
  i_right: line([37, -27], [37, 27]),
  i_top: line([37, 27], [-37, 27]),
  i_left: line([-37, 27], [-37, -27]),
  h1: circle({ center: [41, 31], radius: 1.7 }),
  h2: circle({ center: [-41, 31], radius: 1.7 }),
  h3: circle({ center: [-41, -31], radius: 1.7 }),
  h4: circle({ center: [41, -31], radius: 1.7 }),
});
const gasket = extrude(outline, { distance: 1.5 });

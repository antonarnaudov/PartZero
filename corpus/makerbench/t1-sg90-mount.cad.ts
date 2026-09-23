import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "sg90_mount", description: "SG90 servo mount plate: 40x20x3, 23x12.5 cutout, 2x 2.2 mm screw holes 27.5 apart" });

part("mount");
const outline = sketch(XY, {
  bottom: line([-20, -10], [20, -10]),
  right: line([20, -10], [20, 10]),
  top: line([20, 10], [-20, 10]),
  left: line([-20, 10], [-20, -10]),
  cut_bottom: line([-11.5, -6.25], [11.5, -6.25]),
  cut_right: line([11.5, -6.25], [11.5, 6.25]),
  cut_top: line([11.5, 6.25], [-11.5, 6.25]),
  cut_left: line([-11.5, 6.25], [-11.5, -6.25]),
  screw_l: circle({ center: [-13.75, 0], radius: 1.1 }),
  screw_r: circle({ center: [13.75, 0], radius: 1.1 }),
});
const mount = extrude(outline, { distance: 3 });

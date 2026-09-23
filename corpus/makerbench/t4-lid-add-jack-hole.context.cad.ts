import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "box_lid", description: "90x60x2 box lid with four M3 clearance holes 5 mm in from the corners" });

part("lid");
const outline = sketch(XY, {
  bottom: line([0, 0], [90, 0]),
  right: line([90, 0], [90, 60]),
  top: line([90, 60], [0, 60]),
  left: line([0, 60], [0, 0]),
  screw_bl: circle({ center: [5, 5], radius: 1.7 }),
  screw_br: circle({ center: [85, 5], radius: 1.7 }),
  screw_tr: circle({ center: [85, 55], radius: 1.7 }),
  screw_tl: circle({ center: [5, 55], radius: 1.7 }),
});
const lid = extrude(outline, { distance: 2 });

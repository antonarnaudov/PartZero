import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "mounting_plate", description: "80x50x4 mounting plate with four M4 clearance holes 6 mm from the edges" });

part("plate");
const outline = sketch(XY, {
  bottom: line([-40, -25], [40, -25]),
  right: line([40, -25], [40, 25]),
  top: line([40, 25], [-40, 25]),
  left: line([-40, 25], [-40, -25]),
  hole_ne: circle({ center: [34, 19], radius: 2.2 }),
  hole_nw: circle({ center: [-34, 19], radius: 2.2 }),
  hole_sw: circle({ center: [-34, -19], radius: 2.2 }),
  hole_se: circle({ center: [34, -19], radius: 2.2 }),
});
const plate = extrude(outline, { distance: 4 });

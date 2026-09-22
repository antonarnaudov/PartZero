import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";

doc({ name: "extrude_box", description: "80x50 rectangle extruded 8 mm" });

part("part");
const base = sketch(XY, {
  bottom: line([-40, -25], [40, -25]),
  right: line([40, -25], [40, 25]),
  top: line([40, 25], [-40, 25]),
  left: line([-40, 25], [-40, -25]),
});
const plate = extrude(base, { distance: 8 });

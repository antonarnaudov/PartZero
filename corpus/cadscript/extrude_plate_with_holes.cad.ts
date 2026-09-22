import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";

doc({ name: "extrude_plate_with_holes", description: "Plate with four through holes (holes are sketch loops)" });

part("part");
const base = sketch(XY, {
  bottom: line([0, 0], [100, 0]),
  right: line([100, 0], [100, 60]),
  top: line([100, 60], [0, 60]),
  left: line([0, 60], [0, 0]),
  h1: circle({ center: [10, 10], radius: 2.75 }),
  h2: circle({ center: [90, 10], radius: 2.75 }),
  h3: circle({ center: [90, 50], radius: 2.75 }),
  h4: circle({ center: [10, 50], radius: 2.75 }),
});
const plate = extrude(base, { distance: 5 });

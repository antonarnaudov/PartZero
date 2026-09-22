import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";

doc({ name: "extrude_slot_symmetric_xz", description: "Obround slot on XZ, extruded symmetrically" });

part("part");
const slot = sketch(XZ, {
  lower: line([-20, -6], [20, -6]),
  right_cap: arc({ start: [20, -6], end: [20, 6], center: [20, 0], ccw: true }),
  upper: line([20, 6], [-20, 6]),
  left_cap: arc({ start: [-20, 6], end: [-20, -6], center: [-20, 0], ccw: true }),
});
const bar = extrude(slot, { distance: 10, direction: "symmetric" });

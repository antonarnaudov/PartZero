import { doc, part, sketch, line, arc, circle, extrude, XY } from "@aicad/std";

doc({ name: "corner_bracket_right", description: "Right-hand L corner bracket (mirror of the left-hand one about YZ), 4 mm: 60 mm foot, 50 mm leg, R8 corner, M4 hole, 15 mm slot" });

part("bracket");
// Mirrored about the YZ plane: every x negated. Mirroring reverses the turning direction, so
// every arc's ccw flag flips.
const outline = sketch(XY, {
  corner: arc({ start: [0, 8], end: [-8, 0], center: [-8, 8], ccw: false }),
  bottom: line([-8, 0], [-60, 0]),
  foot_end: line([-60, 0], [-60, 15]),
  foot_top: line([-60, 15], [-15, 15]),
  leg_inner: line([-15, 15], [-15, 50]),
  leg_top: line([-15, 50], [0, 50]),
  leg_outer: line([0, 50], [0, 8]),
  m4: circle({ center: [-50, 7.5], radius: 2.25 }),
  slot_right: line([-9.75, 25], [-9.75, 40]),
  slot_top: arc({ start: [-9.75, 40], end: [-5.25, 40], center: [-7.5, 40], ccw: false }),
  slot_left: line([-5.25, 40], [-5.25, 25]),
  slot_bottom: arc({ start: [-5.25, 25], end: [-9.75, 25], center: [-7.5, 25], ccw: false }),
});
const bracket = extrude(outline, { distance: 4 });

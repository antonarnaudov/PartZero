import { doc, part, sketch, line, arc, extrude, XY } from "@aicad/std";

doc({ name: "gridfinity_cell", description: "Simplified 1x1 Gridfinity-style baseplate frame: 42x42 R4 outside, 36x36 R1 opening, 5 tall" });

part("baseplate");
const frame_outline = sketch(XY, {
  o_bottom: line([-17, -21], [17, -21]),
  o_c1: arc({ start: [17, -21], end: [21, -17], center: [17, -17], ccw: true }),
  o_right: line([21, -17], [21, 17]),
  o_c2: arc({ start: [21, 17], end: [17, 21], center: [17, 17], ccw: true }),
  o_top: line([17, 21], [-17, 21]),
  o_c3: arc({ start: [-17, 21], end: [-21, 17], center: [-17, 17], ccw: true }),
  o_left: line([-21, 17], [-21, -17]),
  o_c4: arc({ start: [-21, -17], end: [-17, -21], center: [-17, -17], ccw: true }),
  i_bottom: line([-17, -18], [17, -18]),
  i_c1: arc({ start: [17, -18], end: [18, -17], center: [17, -17], ccw: true }),
  i_right: line([18, -17], [18, 17]),
  i_c2: arc({ start: [18, 17], end: [17, 18], center: [17, 17], ccw: true }),
  i_top: line([17, 18], [-17, 18]),
  i_c3: arc({ start: [-17, 18], end: [-18, 17], center: [-17, 17], ccw: true }),
  i_left: line([-18, 17], [-18, -17]),
  i_c4: arc({ start: [-18, -17], end: [-17, -18], center: [-17, -17], ccw: true }),
});
const cell = extrude(frame_outline, { distance: 5 });

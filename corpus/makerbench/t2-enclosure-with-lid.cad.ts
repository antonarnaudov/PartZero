import { doc, part, sketch, line, extrude, frame, XY } from "@aicad/std";

doc({ name: "enclosure_with_lid", description: "90x60x30 project box (2 mm floor and walls) plus a lid with a 0.2 mm clearance locating lip, side by side" });

part("box");
const floor_outline = sketch(XY, {
  bottom: line([0, 0], [90, 0]),
  right: line([90, 0], [90, 60]),
  top: line([90, 60], [0, 60]),
  left: line([0, 60], [0, 0]),
});
const floor = extrude(floor_outline, { distance: 2 });
// IR v0 has no booleans: the wall ring is its own body, standing on the floor.
const wall_ring = sketch(frame({ origin: [0, 0, 2], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  o_bottom: line([0, 0], [90, 0]),
  o_right: line([90, 0], [90, 60]),
  o_top: line([90, 60], [0, 60]),
  o_left: line([0, 60], [0, 0]),
  i_bottom: line([2, 2], [88, 2]),
  i_right: line([88, 2], [88, 58]),
  i_top: line([88, 58], [2, 58]),
  i_left: line([2, 58], [2, 2]),
});
const walls = extrude(wall_ring, { distance: 28 });

part("lid");
const lid_outline = sketch(XY, {
  bottom: line([100, 0], [190, 0]),
  right: line([190, 0], [190, 60]),
  top: line([190, 60], [100, 60]),
  left: line([100, 60], [100, 0]),
});
const lid_plate = extrude(lid_outline, { distance: 2 });
// Lip: 85.6 x 55.6 outside (0.2 mm clearance in the 86 x 56 opening), 1.2 mm wall, 4 mm tall.
const lip_ring = sketch(frame({ origin: [0, 0, 2], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  o_bottom: line([102.2, 2.2], [187.8, 2.2]),
  o_right: line([187.8, 2.2], [187.8, 57.8]),
  o_top: line([187.8, 57.8], [102.2, 57.8]),
  o_left: line([102.2, 57.8], [102.2, 2.2]),
  i_bottom: line([103.4, 3.4], [186.6, 3.4]),
  i_right: line([186.6, 3.4], [186.6, 56.6]),
  i_top: line([186.6, 56.6], [103.4, 56.6]),
  i_left: line([103.4, 56.6], [103.4, 3.4]),
});
const lip = extrude(lip_ring, { distance: 4 });

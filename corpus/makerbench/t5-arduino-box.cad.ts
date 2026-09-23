import { doc, part, sketch, line, circle, extrude, frame, XY } from "@aicad/std";

// Assumed (the prompt gives no numbers): an Arduino Uno on four standoffs, open-top box with a
// press-fit lid, 2 mm walls; USB and power openings to be placed once the layout is confirmed.
doc({ name: "arduino_box", description: "Assumed defaults: 84x69x35 box (2 mm walls/floor) for an Arduino Uno on 4 standoffs, plus a lid with a 0.2 mm clearance lip" });

part("box");
const floor_outline = sketch(XY, {
  bottom: line([0, 0], [84, 0]),
  right: line([84, 0], [84, 69]),
  top: line([84, 69], [0, 69]),
  left: line([0, 69], [0, 0]),
});
const floor = extrude(floor_outline, { distance: 2 });
const wall_ring = sketch(frame({ origin: [0, 0, 2], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  o_bottom: line([0, 0], [84, 0]),
  o_right: line([84, 0], [84, 69]),
  o_top: line([84, 69], [0, 69]),
  o_left: line([0, 69], [0, 0]),
  i_bottom: line([2, 2], [82, 2]),
  i_right: line([82, 2], [82, 67]),
  i_top: line([82, 67], [2, 67]),
  i_left: line([2, 67], [2, 2]),
});
const walls = extrude(wall_ring, { distance: 33 });
// Uno mounting holes (13.97, 2.54), (15.24, 50.8), (66.04, 7.62), (66.04, 35.56) from the board
// corner, with the 68.6 x 53.3 board centred in the 80 x 65 inside (corner at 7.7, 7.85).
// 6 mm standoffs with 2.5 mm pilot holes for M3 self-tapping screws, 6 mm tall.
const standoff_rings = sketch(frame({ origin: [0, 0, 2], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  s1: circle({ center: [21.67, 10.39], radius: 3 }),
  s1_pilot: circle({ center: [21.67, 10.39], radius: 1.25 }),
  s2: circle({ center: [22.94, 58.65], radius: 3 }),
  s2_pilot: circle({ center: [22.94, 58.65], radius: 1.25 }),
  s3: circle({ center: [73.74, 15.47], radius: 3 }),
  s3_pilot: circle({ center: [73.74, 15.47], radius: 1.25 }),
  s4: circle({ center: [73.74, 43.41], radius: 3 }),
  s4_pilot: circle({ center: [73.74, 43.41], radius: 1.25 }),
});
const standoffs = extrude(standoff_rings, { distance: 6 });

part("lid");
const lid_outline = sketch(XY, {
  bottom: line([94, 0], [178, 0]),
  right: line([178, 0], [178, 69]),
  top: line([178, 69], [94, 69]),
  left: line([94, 69], [94, 0]),
});
const lid = extrude(lid_outline, { distance: 2 });
// Locating lip: 79.6 x 64.6 outside (0.2 mm clearance in the 80 x 65 opening), 1.2 mm wall, 3 mm tall.
const lip_ring = sketch(frame({ origin: [0, 0, 2], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  o_bottom: line([96.2, 2.2], [175.8, 2.2]),
  o_right: line([175.8, 2.2], [175.8, 66.8]),
  o_top: line([175.8, 66.8], [96.2, 66.8]),
  o_left: line([96.2, 66.8], [96.2, 2.2]),
  i_bottom: line([97.4, 3.4], [174.6, 3.4]),
  i_right: line([174.6, 3.4], [174.6, 65.6]),
  i_top: line([174.6, 65.6], [97.4, 65.6]),
  i_left: line([97.4, 65.6], [97.4, 3.4]),
});
const lip = extrude(lip_ring, { distance: 3 });

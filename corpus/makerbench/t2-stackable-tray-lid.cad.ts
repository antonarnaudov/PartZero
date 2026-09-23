import { doc, part, sketch, line, extrude, frame, XY } from "@aicad/std";

doc({ name: "stackable_tray_lid", description: "Stackable 100x60x28 parts tray (2 compartments, 3 mm stacking foot with 0.3 mm clearance) and a lid with the same locating ring" });

part("tray");
// Stacking foot, z 0..3: fits the 96.8 x 56.8 opening of the tray below with 0.3 mm all round.
const foot_ring = sketch(XY, {
  o_bottom: line([1.9, 1.9], [98.1, 1.9]),
  o_right: line([98.1, 1.9], [98.1, 58.1]),
  o_top: line([98.1, 58.1], [1.9, 58.1]),
  o_left: line([1.9, 58.1], [1.9, 1.9]),
  i_bottom: line([3.5, 3.5], [96.5, 3.5]),
  i_right: line([96.5, 3.5], [96.5, 56.5]),
  i_top: line([96.5, 56.5], [3.5, 56.5]),
  i_left: line([3.5, 56.5], [3.5, 3.5]),
});
const foot = extrude(foot_ring, { distance: 3 });
// IR v0 has no booleans: floor, walls and divider are separate bodies that touch.
const floor_outline = sketch(frame({ origin: [0, 0, 3], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  bottom: line([0, 0], [100, 0]),
  right: line([100, 0], [100, 60]),
  top: line([100, 60], [0, 60]),
  left: line([0, 60], [0, 0]),
});
const floor = extrude(floor_outline, { distance: 2 });
const wall_ring = sketch(frame({ origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  o_bottom: line([0, 0], [100, 0]),
  o_right: line([100, 0], [100, 60]),
  o_top: line([100, 60], [0, 60]),
  o_left: line([0, 60], [0, 0]),
  i_bottom: line([1.6, 1.6], [98.4, 1.6]),
  i_right: line([98.4, 1.6], [98.4, 58.4]),
  i_top: line([98.4, 58.4], [1.6, 58.4]),
  i_left: line([1.6, 58.4], [1.6, 1.6]),
});
const walls = extrude(wall_ring, { distance: 23 });
// Divider across the middle, 3 mm below the rim so the foot of the tray above clears it.
const divider_outline = sketch(frame({ origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  d_bottom: line([49.2, 1.6], [50.8, 1.6]),
  d_right: line([50.8, 1.6], [50.8, 58.4]),
  d_top: line([50.8, 58.4], [49.2, 58.4]),
  d_left: line([49.2, 58.4], [49.2, 1.6]),
});
const divider = extrude(divider_outline, { distance: 20 });

part("lid");
const lid_outline = sketch(XY, {
  bottom: line([110, 0], [210, 0]),
  right: line([210, 0], [210, 60]),
  top: line([210, 60], [110, 60]),
  left: line([110, 60], [110, 0]),
});
const lid_plate = extrude(lid_outline, { distance: 2 });
const lid_ring_outline = sketch(frame({ origin: [0, 0, 2], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  o_bottom: line([111.9, 1.9], [208.1, 1.9]),
  o_right: line([208.1, 1.9], [208.1, 58.1]),
  o_top: line([208.1, 58.1], [111.9, 58.1]),
  o_left: line([111.9, 58.1], [111.9, 1.9]),
  i_bottom: line([113.5, 3.5], [206.5, 3.5]),
  i_right: line([206.5, 3.5], [206.5, 56.5]),
  i_top: line([206.5, 56.5], [113.5, 56.5]),
  i_left: line([113.5, 56.5], [113.5, 3.5]),
});
const lid_ring = extrude(lid_ring_outline, { distance: 3 });

import { doc, part, sketch, line, extrude, frame, XY } from "@aicad/std";

doc({ name: "parts_tray", description: "128x80x25 tray, 2 mm floor and walls, two 2 mm dividers making three 40 mm compartments" });

part("tray");
const floor_outline = sketch(XY, {
  bottom: line([0, 0], [128, 0]),
  right: line([128, 0], [128, 80]),
  top: line([128, 80], [0, 80]),
  left: line([0, 80], [0, 0]),
});
const floor = extrude(floor_outline, { distance: 2 });
const wall_ring = sketch(frame({ origin: [0, 0, 2], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  o_bottom: line([0, 0], [128, 0]),
  o_right: line([128, 0], [128, 80]),
  o_top: line([128, 80], [0, 80]),
  o_left: line([0, 80], [0, 0]),
  i_bottom: line([2, 2], [126, 2]),
  i_right: line([126, 2], [126, 78]),
  i_top: line([126, 78], [2, 78]),
  i_left: line([2, 78], [2, 2]),
});
const walls = extrude(wall_ring, { distance: 23 });
const divider_outlines = sketch(frame({ origin: [0, 0, 2], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  d1_bottom: line([42, 2], [44, 2]),
  d1_right: line([44, 2], [44, 78]),
  d1_top: line([44, 78], [42, 78]),
  d1_left: line([42, 78], [42, 2]),
  d2_bottom: line([84, 2], [86, 2]),
  d2_right: line([86, 2], [86, 78]),
  d2_top: line([86, 78], [84, 78]),
  d2_left: line([84, 78], [84, 2]),
});
const dividers = extrude(divider_outlines, { distance: 23 });

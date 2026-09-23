import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "filament_clip", description: "Spool-rim filament clip: 20x14x6, 3.2 wide x 10 deep flange slot, 2x 2.2 mm filament holes" });

part("clip");
const outline = sketch(XY, {
  bottom_l: line([0, 0], [8.4, 0]),
  slot_l: line([8.4, 0], [8.4, 10]),
  slot_end: line([8.4, 10], [11.6, 10]),
  slot_r: line([11.6, 10], [11.6, 0]),
  bottom_r: line([11.6, 0], [20, 0]),
  right: line([20, 0], [20, 14]),
  top: line([20, 14], [0, 14]),
  left: line([0, 14], [0, 0]),
  // 1.75 mm filament: 2.2 mm holes, 5 mm up and 4.2 mm in from the sides.
  hole_l: circle({ center: [4.2, 5], radius: 1.1 }),
  hole_r: circle({ center: [15.8, 5], radius: 1.1 }),
});
const clip = extrude(outline, { distance: 6 });

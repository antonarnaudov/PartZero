import { doc, part, sketch, line, extrude, XY } from "@aicad/std";

doc({ name: "shelf_bracket", description: "Flat triangular shelf bracket: 100 along the wall, 80 along the shelf, 10 thick, 12 mm arms" });

part("bracket");
// Right angle at the origin: x = shelf leg (80), y = wall leg (100).
// The window is the outline offset 12 mm inwards: x = 12, y = 12 and the hypotenuse
// 100x + 80y = 8000 moved in by 12 mm (100x + 80y = 8000 - 12 * sqrt(16400)).
const outline = sketch(XY, {
  shelf_edge: line([0, 0], [80, 0]),
  brace: line([80, 0], [0, 100]),
  wall_edge: line([0, 100], [0, 0]),
  win_bottom: line([12, 12], [55.032501830161166, 12]),
  win_brace: line([55.032501830161166, 12], [12, 65.79062728770145]),
  win_side: line([12, 65.79062728770145], [12, 12]),
});
const bracket = extrude(outline, { distance: 10 });

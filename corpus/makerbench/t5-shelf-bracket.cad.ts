import { doc, part, sketch, line, extrude, XY } from "@aicad/std";

// Assumed (the prompt gives no numbers): a ~150 mm deep shelf, light load, printed flat in PETG.
doc({ name: "shelf_bracket", description: "Assumed defaults: triangular bracket, 150 along the wall, 120 along the shelf, 15 thick, 15 mm arms" });

part("bracket");
const outline = sketch(XY, {
  shelf_edge: line([0, 0], [120, 0]),
  brace: line([120, 0], [0, 150]),
  wall_edge: line([0, 150], [0, 0]),
  win_bottom: line([15, 15], [88.79062728770145, 15]),
  win_brace: line([88.79062728770145, 15], [15, 107.23828410962682]),
  win_side: line([15, 107.23828410962682], [15, 15]),
});
const bracket = extrude(outline, { distance: 15 });

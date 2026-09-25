import { doc, part, sketch, extrude, rect, hole, grid, XY } from "@aicad/std";

doc({ name: "cover_plate", description: "100x60x5 cover plate, four M5 holes 10 mm from the edges" });

part("cover");
const outline = sketch(XY, { plate: rect({ center: [0, 0], w: 100, h: 60 }) });
const cover = extrude(outline, { distance: 5 });
const screws = hole(cover.cap("end"), { at: grid({ nx: 2, ny: 2, dx: 80, dy: 40 }), size: "M5", depth: "through" });

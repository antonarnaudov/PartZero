import { doc, part, sketch, extrude, rect, fillet, hole, grid, XY, Z } from "@aicad/std";

doc({ name: "nema17_cbore_plate", description: "60x60x6 NEMA 17 plate: R6 corners, Ø22.5 pilot hole, four M3 counterbored holes on 31 mm" });

part("plate");
const outline = sketch(XY, { plate: rect({ center: [0, 0], w: 60, h: 60 }) });
const plate = extrude(outline, { distance: 6 });
const corners = fillet(plate.sides().edges().parallel(Z), { r: 6 });
const pilot = hole(plate.cap("end"), { at: { pilot: [0, 0] }, d: 22.5, depth: "through" });
const screws = hole(plate.cap("end"), { at: grid({ nx: 2, ny: 2, dx: 31, dy: 31 }), size: "M3", depth: "through", cbore: "iso4762" });

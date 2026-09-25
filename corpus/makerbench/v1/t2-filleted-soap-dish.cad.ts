import { doc, part, param, sketch, extrude, rect, fillet, shell, XY, Z } from "@aicad/std";

doc({ name: "filleted_soap_dish", description: "90x60x20 dish: R8 vertical corners, R3 bottom edges, then shelled 2 mm with the top open" });

const wall = param(2, { min: 1.2, max: 2.8, note: "wall thickness" });

part("dish");
const outline = sketch(XY, { outline: rect({ center: [0, 0], w: 90, h: 60 }) });
const dish = extrude(outline, { distance: 20 });
const corners = fillet(dish.sides().edges().parallel(Z), { r: 8 });
const bottomEdges = fillet(dish.cap("start").edges(), { r: 3 });
const hollow = shell(dish, { open: dish.cap("end"), thickness: wall });

// expect: fail — the dish is hollowed with a pocket cut and a filleted floor, not with the shell feature the prompt asks for: the part is right, only shelled and open_top (shell_*) fail
import { doc, part, param, sketch, extrude, rect, fillet, XY, Z } from "@aicad/std";

doc({ name: "filleted_soap_dish", description: "90x60x20 dish: R8 vertical corners, R3 bottom edges, hollowed by a pocket with R1 floor rounds" });

const wall = param(2, { min: 1.2, max: 2.8, note: "wall thickness" });

part("dish");
const outline = sketch(XY, { outline: rect({ center: [0, 0], w: 90, h: 60 }) });
const dish = extrude(outline, { distance: 20 });
const corners = fillet(dish.sides().edges().parallel(Z), { r: 8 });
const bottomEdges = fillet(dish.cap("start").edges(), { r: 3 });
const pocketSk = sketch(dish.cap("end"), { inside: rect({ center: [0, 0], w: 90 - 2 * wall, h: 60 - 2 * wall, r: 8 - wall }) });
const pocket = extrude(pocketSk, { distance: 20 - wall, direction: "reverse", op: "cut", targets: dish });
const floorRounds = fillet(pocket.cap("end").edges(), { r: 3 - wall });

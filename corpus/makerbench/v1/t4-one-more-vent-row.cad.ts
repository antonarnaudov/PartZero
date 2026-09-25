import { doc, part, sketch, extrude, rect, circle, linearPattern, XY, X, Y } from "@aicad/std";

doc({ name: "vent_grille", description: "100x70x2 grille with a 6x4 grid of Ø6 vent holes every 12 mm" });

part("grille");
const outline = sketch(XY, { plate: rect({ center: [0, 0], w: 100, h: 70 }) });
const grille = extrude(outline, { distance: 2 });
const ventSk = sketch(XY, { vent: circle({ center: [-30, -18], radius: 3 }) });
const vent = extrude(ventSk, { distance: 2, op: "cut", targets: grille });
const vents = linearPattern([vent], { dir: X, count: 6, spacing: 12, dir2: Y, count2: 4, spacing2: 12 });

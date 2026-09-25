import { doc, part, param, sketch, extrude, rect, fillet, shell, hole, XY, Z } from "@aicad/std";

doc({ name: "cable_box", description: "80x50x30 open box, R4 corners, 2 mm walls, a Ø8 cable hole in one end" });

const wall = param(2, { min: 1.2, max: 4, note: "wall and floor thickness" });

part("box");
const outline = sketch(XY, { outline: rect({ center: [0, 0], w: 80, h: 50 }) });
const box = extrude(outline, { distance: 30 });
const corners = fillet(box.sides().edges().parallel(Z), { r: 4 });
const hollow = shell(box, { open: box.cap("end"), thickness: wall });
const cable = hole(box.side("outline.right"), { at: { cable: [0, 15] }, d: 8, depth: "through" });

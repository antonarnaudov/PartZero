import { doc, part, sketch, extrude, rect, chamfer, shell, XY } from "@aicad/std";

doc({ name: "rounded_box_chamfered_lid", description: "Rounded 70x50x25 box (R6 corners, 2 mm walls) and a 3 mm lid with a 1 mm chamfer on its top edge" });

part("box");
const boxSk = sketch(XY, { outline: rect({ center: [0, 0], w: 70, h: 50, r: 6 }) });
const box = extrude(boxSk, { distance: 25 });
const hollow = shell(box, { open: box.cap("end"), thickness: 2 });

part("lid");
const lidSk = sketch(XY, { lid_outline: rect({ center: [80, 0], w: 70, h: 50, r: 6 }) });
const lid = extrude(lidSk, { distance: 3 });
const lidEdge = chamfer(lid.cap("end").edges(), { d: 1 });

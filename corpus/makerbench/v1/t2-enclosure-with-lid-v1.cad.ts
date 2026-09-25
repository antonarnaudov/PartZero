import { doc, part, param, sketch, extrude, shell, rect, XY } from "@aicad/std";

doc({ name: "enclosure_with_lid", description: "Two-part project box: shelled 90x60x30 box and a 2 mm lid with a locating lip" });

const width = param(90, { note: "outside X" });
const depth = param(60, { note: "outside Y" });
const wall = param(2, { note: "wall, floor and lid thickness" });
const clearance = param(0.2, { note: "lip clearance all round" });

part("box");
const boxSk = sketch(XY, { outline: rect({ corner: [0, 0], w: width, h: depth }) });
const box = extrude(boxSk, { distance: 30 });
const hollow = shell(box, { open: box.cap("end"), thickness: wall });

part("lid");
const lidSk = sketch(XY, { plate: rect({ corner: [width + 10, 0], w: width, h: depth }) });
const lid = extrude(lidSk, { distance: wall });
const lipSk = sketch(lid.cap("end"), {
  lip_out: rect({ corner: [width + 10 + wall + clearance, wall + clearance], w: width - 2 * (wall + clearance), h: depth - 2 * (wall + clearance) }),
  lip_in: rect({ corner: [width + 10 + wall + clearance + 1.2, wall + clearance + 1.2], w: width - 2 * (wall + clearance + 1.2), h: depth - 2 * (wall + clearance + 1.2) }),
});
const lip = extrude(lipSk, { distance: 4, op: "join", targets: lid });

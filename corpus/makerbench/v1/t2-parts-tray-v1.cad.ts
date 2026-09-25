import { doc, part, param, sketch, extrude, shell, rect, XY } from "@aicad/std";

doc({ name: "parts_tray", description: "Shelled 128x80x25 parts tray with two 2 mm dividers making three 40 mm compartments" });

const wall = param(2, { note: "floor, wall and divider thickness" });

part("tray");
const outline = sketch(XY, { outline: rect({ corner: [0, 0], w: 128, h: 80 }) });
const tray = extrude(outline, { distance: 25 });
const hollow = shell(tray, { open: tray.cap("end"), thickness: wall });
const dividerSk = sketch(XY, {
  d1: rect({ corner: [wall + 40, 0], w: wall, h: 80 }),
  d2: rect({ corner: [2 * wall + 80, 0], w: wall, h: 80 }),
});
const dividers = extrude(dividerSk, { distance: 25, op: "join", targets: tray });

import { doc, part, param, sketch, extrude, rect, shell, XY } from "@aicad/std";

doc({ name: "screw_bin", description: "Hand-sized screw bin: 90x60x40, R8 corners, 2 mm walls; every default is a parameter" });

const width = param(90, { min: 40, max: 200, note: "outside width (assumed: hand-sized)" });
const depth = param(60, { min: 30, max: 150, note: "outside depth" });
const height = param(40, { min: 20, max: 100, note: "outside height" });
const corner = param(8, { min: 1, max: 15, note: "corner radius" });
const wall = param(2, { min: 1.2, max: 4, note: "wall and floor thickness" });

part("bin");
const outline = sketch(XY, { outline: rect({ center: [0, 0], w: width, h: depth, r: corner }) });
const bin = extrude(outline, { distance: height });
const hollow = shell(bin, { open: bin.cap("end"), thickness: wall });

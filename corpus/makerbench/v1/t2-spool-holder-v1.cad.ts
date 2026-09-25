import { doc, part, sketch, extrude, rect, circle, chamfer, hole, grid, XY } from "@aicad/std";

doc({ name: "spool_holder", description: "Spool holder: 60x60x5 base with 4x M4 holes on a 50 mm square, joined 30x80 spindle with a 2 mm top chamfer" });

part("holder");
const baseSk = sketch(XY, { plate: rect({ center: [0, 0], w: 60, h: 60 }) });
const base = extrude(baseSk, { distance: 5 });
const spindleSk = sketch(base.cap("end"), { post: circle({ center: [0, 0], radius: 15 }) });
const spindle = extrude(spindleSk, { distance: 80, op: "join", targets: base });
const topEdge = chamfer(spindle.cap("end").edges(), { d: 2 });
const mounts = hole(base.cap("end"), { at: grid({ nx: 2, ny: 2, dx: 50, dy: 50 }), size: "M4", depth: "through" });

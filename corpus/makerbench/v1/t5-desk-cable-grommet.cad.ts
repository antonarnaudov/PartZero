import { doc, part, param, sketch, extrude, circle, XY } from "@aicad/std";

doc({ name: "desk_cable_grommet", description: "Desk grommet for a 60 mm hole: Ø60 x 18 sleeve with a Ø70 x 2 flange and a Ø49.4 bore" });

const hole_d = param(60, { min: 30, max: 100, note: "desk hole diameter (assumed: the common 60 mm)" });
const desk = param(18, { min: 12, max: 40, note: "sleeve length (assumed: 18 mm desk top)" });
const flange = param(5, { min: 3, max: 10, note: "flange overhang" });
const wall = param(5, { min: 2, max: 8, note: "sleeve wall" });

part("grommet");
const flangeSk = sketch(XY, { rim: circle({ center: [0, 0], radius: hole_d / 2 + flange }) });
const grommet = extrude(flangeSk, { distance: 2 });
const sleeveSk = sketch(XY, { sleeve: circle({ center: [0, 0], radius: hole_d / 2 - 0.3 }) });
const sleeve = extrude(sleeveSk, { distance: desk, direction: "reverse", op: "join", targets: grommet });
const boreSk = sketch(XY, { bore: circle({ center: [0, 0], radius: hole_d / 2 - 0.3 - wall }) });
const bore = extrude(boreSk, { distance: desk + 2, direction: "symmetric", op: "cut", targets: grommet });

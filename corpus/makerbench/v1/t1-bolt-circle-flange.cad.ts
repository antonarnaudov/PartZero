import { doc, part, param, sketch, extrude, circle, chamfer, hole, boltCircle, XY } from "@aicad/std";

doc({ name: "bolt_circle_flange", description: "Ø80x8 flange: Ø25 bore, six M6 close-fit holes on a Ø62 bolt circle, 1 mm top chamfer" });

const bolts = param(6, { unit: "count", min: 3, note: "number of bolt holes" });

part("flange");
const disc = sketch(XY, { rim: circle({ center: [0, 0], radius: 40 }) });
const flange = extrude(disc, { distance: 8 });
const topEdge = chamfer(flange.cap("end").edges(), { d: 1 });
const bore = hole(flange.cap("end"), { at: { bore: [0, 0] }, d: 25, depth: "through" });
const boltHoles = hole(flange.cap("end"), { at: boltCircle({ n: bolts, d: 62 }), size: "M6", fit: "close", depth: "through" });

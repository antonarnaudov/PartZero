// expect: fail — the bolt holes are Ø6.4 circles cut through and patterned, not the hole features with the M6 preset the prompt asks for: the part is right, only bolt_holes (hole_count) fails
import { doc, part, param, sketch, extrude, circle, chamfer, hole, circularPattern, XY, Z } from "@aicad/std";

doc({ name: "bolt_circle_flange", description: "Ø80x8 flange: Ø25 bore, six Ø6.4 bolt holes cut on a Ø62 bolt circle, 1 mm top chamfer" });

const bolts = param(6, { unit: "count", min: 3, note: "number of bolt holes" });

part("flange");
const disc = sketch(XY, { rim: circle({ center: [0, 0], radius: 40 }) });
const flange = extrude(disc, { distance: 8 });
const topEdge = chamfer(flange.cap("end").edges(), { d: 1 });
const bore = hole(flange.cap("end"), { at: { bore: [0, 0] }, d: 25, depth: "through" });
const boltSk = sketch(XY, { bolt: circle({ center: [31, 0], radius: 3.2 }) });
const boltCut = extrude(boltSk, { distance: 8, op: "cut", targets: flange });
const boltHoles = circularPattern([boltCut], { axis: Z, count: bolts });

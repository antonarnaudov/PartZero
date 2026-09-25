import { doc, part, sketch, extrude, circle, line, revolve, hole, circularPattern, XY, XZ, Z } from "@aicad/std";

doc({ name: "pulley_lightening_holes", description: "Ø60x12 V-groove pulley blank: Ø8 bore, six Ø10 lightening holes on a Ø36 circle" });

part("pulley");
const discSk = sketch(XY, { rim: circle({ center: [0, 0], radius: 30 }) });
const pulley = extrude(discSk, { distance: 12 });
const grooveSk = sketch(XZ, {
  g1: line([31, 1], [26, 6]),
  g2: line([26, 6], [31, 11]),
  g3: line([31, 11], [31, 1]),
});
const groove = revolve(grooveSk, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360, op: "cut", targets: pulley });
const bore = hole(pulley.cap("end"), { at: { axle: [0, 0] }, d: 8, depth: "through" });
const lighten = hole(pulley.cap("end"), { at: { l0: [18, 0] }, d: 10, depth: "through" });
const lightenAll = circularPattern([lighten], { axis: Z, count: 6 });

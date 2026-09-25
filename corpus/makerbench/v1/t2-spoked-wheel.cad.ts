import { doc, part, param, sketch, extrude, circle, rect, circularPattern, hole, XY, Z } from "@aicad/std";

doc({ name: "spoked_wheel", description: "Ø100x10 wheel: 8 mm rim, Ø28 hub with an Ø8 bore, five 8 mm spokes" });

const spokes = param(5, { unit: "count", min: 3, note: "number of spokes" });

part("wheel");
const discSk = sketch(XY, { tire: circle({ center: [0, 0], radius: 50 }) });
const wheel = extrude(discSk, { distance: 10 });
const ringSk = sketch(XY, {
  ring_out: circle({ center: [0, 0], radius: 42 }),
  ring_in: circle({ center: [0, 0], radius: 14 }),
});
const lighten = extrude(ringSk, { distance: 10, regions: ["ring_out"], op: "cut", targets: wheel });
const spokeSk = sketch(XY, { spoke: rect({ center: [28, 0], w: 30, h: 8 }) });
const spoke = extrude(spokeSk, { distance: 10, op: "join", targets: wheel });
const allSpokes = circularPattern([spoke], { axis: Z, count: spokes });
const bore = hole(wheel.cap("end"), { at: { axle: [0, 0] }, d: 8, depth: "through" });

import { doc, part, param, sketch, extrude, rect, circle, fillet, XY, YZ } from "@aicad/std";

doc({ name: "snap_fit_lid", description: "80x60x2 lid with a 1.2 mm lip hanging 5 mm down and two snap beads on the long sides; top edge R1" });

const clearance = param(0.2, { min: 0, max: 0.5, note: "lip clearance to a 2 mm walled box" });

part("lid");
const plateSk = sketch(XY, { plate: rect({ center: [0, 0], w: 80, h: 60 }) });
const lid = extrude(plateSk, { distance: 2 });
const lipSk = sketch(XY, {
  lip_out: rect({ center: [0, 0], w: 76 - 2 * clearance, h: 56 - 2 * clearance }),
  lip_in: rect({ center: [0, 0], w: 73.6 - 2 * clearance, h: 53.6 - 2 * clearance }),
});
const lip = extrude(lipSk, { distance: 5, direction: "reverse", regions: ["lip_out.bottom"], op: "join", targets: lid });
const beadSk = sketch(YZ, {
  front: circle({ center: [-(28 - clearance), -3.5], radius: 0.6 }),
  back: circle({ center: [28 - clearance, -3.5], radius: 0.6 }),
});
const beads = extrude(beadSk, { distance: 30, direction: "symmetric", op: "join", targets: lid });
const topEdge = fillet(lid.cap("end").edges(), { r: 1 });

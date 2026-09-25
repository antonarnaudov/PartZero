import { doc, part, param, sketch, extrude, rect, linearPattern, XY, X } from "@aicad/std";

doc({ name: "cable_comb", description: "100x10x6 cable comb spine with twelve 3x20 teeth every 8.8 mm" });

const teeth = param(12, { unit: "count", min: 2, note: "number of teeth" });

part("comb");
const spineSk = sketch(XY, { spine: rect({ corner: [0, 0], w: 100, h: 10 }) });
const spine = extrude(spineSk, { distance: 6 });
const toothSk = sketch(XY, { tooth: rect({ corner: [0, 10], w: 3, h: 20 }) });
const tooth = extrude(toothSk, { distance: 6, op: "join", targets: spine });
const row = linearPattern([tooth], { dir: X, count: teeth, spacing: 8.8 });

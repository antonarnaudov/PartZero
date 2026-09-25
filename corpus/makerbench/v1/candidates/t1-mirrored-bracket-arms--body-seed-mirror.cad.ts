// expect: pass — the second arm is a mirror of the whole body (a body-seed pattern joined back into it), not of the arm features: its hole is a copy of the first arm's
import { doc, part, sketch, extrude, rect, hole, mirror, XY, YZ } from "@aicad/std";

doc({ name: "mirrored_bracket_arms", description: "80x30x5 base with two 5x20x30 upright arms at the ends, each with an M4 hole; one arm mirrored" });

part("bracket");
const baseSk = sketch(XY, { base: rect({ center: [0, 0], w: 80, h: 30 }) });
const base = extrude(baseSk, { distance: 5 });
const armSk = sketch(base.cap("end"), { arm: rect({ corner: [30, -10], w: 5, h: 20 }) });
const arm = extrude(armSk, { distance: 30, op: "join", targets: base });
const armHole = hole(arm.side("arm.right"), { at: { h: [0, 25] }, size: "M4", depth: "through" });
const otherArm = mirror(base.body(), { plane: YZ, op: "join", targets: base });

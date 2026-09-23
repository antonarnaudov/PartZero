import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ, param, rect, slot, polygon, fillet, chamfer, shell, draft, boolean, linearPattern, circularPattern, datumPlane, datumAxis, tag, X, Y, Z } from "@aicad/std";

doc({ name: "shell_box", description: "SPEC-v1 §3.3, §3.4, §6.3, §6.4, §6.8, §6.9, §6.10 examples: shell, draft, slot vents, hex standoff, boolean, revolve cut, datums, body patterns" });

const w = param(60);
const d = param(40);
const h = param(30);
const wall = param(2, { min: 0.8 });
const tapered = param(true);
const vents = param(3, { unit: "count" });
const tilt = param(30, { unit: "deg" });

part("box");
const base = sketch(XY, {
  outline: rect({ center: [0, 0], w: w, h: d, r: 3 }),
});
const body1 = extrude(base, { distance: h });
const hollow = shell(body1, { open: body1.cap("end"), thickness: wall });
const taper = draft(body1.sides(), { neutral: XY, angle: 1.5, suppressed: !tapered });
const ventSk = sketch(XZ, {
  vent: slot({ a: [-10, 20], b: [10, 20], w: 3 }),
});
const vent = extrude(ventSk, { distance: 100, direction: "symmetric", op: "cut", targets: "all" });
const ventRow = linearPattern([vent], { dir: Z, count: vents, spacing: -5 });
const lidPlane = datumPlane({ offset: body1.cap("end"), distance: 5 });
const hexSk = sketch(lidPlane, {
  hex: polygon({ n: 6, acrossFlats: 5.5 }),
});
const standoff = extrude(hexSk, { distance: 10 });
const merged = boolean("join", { targets: body1, tools: standoff });
const grooveSk = sketch(XZ, {
  prof: rect({ corner: [10, 0], w: 2, h: 1 }),
});
const groove = revolve(grooveSk, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360, op: "cut", targets: body1 });
const tiltedPlane = datumPlane({ from: XY, axis: X, angle: tilt });
const slant = datumPlane({ through: [[0, 0, 0], [10, 0, 0], body1.edgeAt("outline.left", "end").vertices().max("+Z").exactly(1)] });
const frame1 = datumPlane({ origin: [0, 0, h], normal: [0, 0, 1], xDir: [1, 0, 0] });
const hinge = datumAxis({ planes: [XZ, tiltedPlane] });
const diag = datumAxis({ points: [[0, 0, 0], [1, 1, 1]], flip: true });
const edgeAxis = datumAxis({ edge: body1.edgeAt("outline.bottom", "end") });
const rim = tag(body1.cap("end").edges().convex());
const rimRound = fillet(rim, { r: 0.5, tangentChain: false });
const bottomChamfer = chamfer(body1.cap("start").edges(), { d: 1, angle: 30, side: body1.cap("start") });
const copies = circularPattern(standoff, { axis: { line: { origin: [0, 0, 0], direction: [0, 0, 1] }, flip: true }, count: 4, skip: [[2]] });
const grid = linearPattern(standoff, { dir: [1, 0, 0], count: 2, spacing: 15, dir2: Y, count2: 2, spacing2: 15, op: "join", targets: body1 });

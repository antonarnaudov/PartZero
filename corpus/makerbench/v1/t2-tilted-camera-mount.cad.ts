import { doc, part, param, sketch, extrude, rect, hole, datumPlane, XY, XZ, X } from "@aicad/std";

doc({ name: "tilted_camera_mount", description: "60x40x5 base with a 60x50x5 plate leaning back 60° from the front top edge, two M3 holes in the plate" });

const tilt = param(60, { unit: "deg", min: 30, max: 90, note: "plate angle from the base" });

part("mount");
const baseSk = sketch(XY, { base: rect({ corner: [-30, 0], w: 60, h: 40 }) });
const base = extrude(baseSk, { distance: 5, direction: "reverse" });
const leaning = datumPlane({ from: XZ, axis: X, angle: tilt - 90 });
const plateSk = sketch(leaning, { plate: rect({ corner: [-30, 0], w: 60, h: 50 }) });
const plate = extrude(plateSk, { distance: 5, direction: "reverse", op: "join", targets: base });
const camHoles = hole(plate.cap("start"), { at: { a: [-10, 35], b: [10, 35] }, size: "M3", depth: "through" });

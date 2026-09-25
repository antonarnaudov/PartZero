import { doc, part, sketch, extrude, rect, hole, XY } from "@aicad/std";

doc({ name: "clamp_bar", description: "120x30x12 clamp bar with four M5 clearance holes along its centre line" });

part("bar");
const outline = sketch(XY, { bar: rect({ center: [0, 0], w: 120, h: 30 }) });
const bar = extrude(outline, { distance: 12 });
const bolts = hole(bar.cap("end"), { at: { a: [-45, 0], b: [-15, 0], c: [15, 0], d: [45, 0] }, size: "M5", depth: "through" });

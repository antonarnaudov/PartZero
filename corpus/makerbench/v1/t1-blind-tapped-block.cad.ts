import { doc, part, sketch, extrude, rect, hole, XY } from "@aicad/std";

doc({ name: "blind_tapped_block", description: "40x20x15 sensor block: two blind tapped M5 holes 10 deep on top, an M5 clearance hole across" });

part("block");
const outline = sketch(XY, { body: rect({ center: [0, 0], w: 40, h: 20 }) });
const block = extrude(outline, { distance: 15 });
const tapped = hole(block.cap("end"), { at: { a: [-12, 0], b: [12, 0] }, size: "M5", thread: true, depth: { blind: 10 } });
const cross = hole(block.side("body.bottom"), { at: { x: [0, 7.5] }, size: "M5", depth: "through" });

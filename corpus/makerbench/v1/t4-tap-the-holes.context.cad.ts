import { doc, part, sketch, extrude, rect, hole, XY } from "@aicad/std";

doc({ name: "motor_boss_block", description: "50x30x20 block with two Ø5 blind holes 12 mm deep in the top" });

part("block");
const outline = sketch(XY, { block: rect({ center: [0, 0], w: 50, h: 30 }) });
const block = extrude(outline, { distance: 20 });
const pilots = hole(block.cap("end"), { at: { a: [-15, 0], b: [15, 0] }, d: 5, depth: { blind: 12 } });

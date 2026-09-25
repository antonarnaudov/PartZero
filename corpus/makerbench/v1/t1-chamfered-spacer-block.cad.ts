import { doc, part, sketch, extrude, rect, chamfer, hole, XY } from "@aicad/std";

doc({ name: "chamfered_spacer_block", description: "30x30x12 spacer: 1 mm chamfers on the top and bottom edges, M6 clearance hole" });

part("spacer");
const outline = sketch(XY, { block: rect({ center: [0, 0], w: 30, h: 30 }) });
const spacer = extrude(outline, { distance: 12 });
const edges = chamfer(spacer.cap("end").edges().and(spacer.cap("start").edges()), { d: 1 });
const bolt = hole(spacer.cap("end"), { at: { m6: [0, 0] }, size: "M6", depth: "through" });

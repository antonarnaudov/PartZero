import { doc, part, sketch, extrude, rect, fillet, XY, Z } from "@aicad/std";

doc({ name: "pocketed_block", description: "70x50x25 block with a 40x24x13 pocket whose vertical inside corners are rounded R5" });

part("block");
const outline = sketch(XY, { outline: rect({ center: [0, 0], w: 70, h: 50 }) });
const block = extrude(outline, { distance: 25 });
const pocketSk = sketch(block.cap("end"), { pocket: rect({ center: [0, 0], w: 40, h: 24 }) });
const pocket = extrude(pocketSk, { distance: 13, direction: "reverse", op: "cut", targets: block });
const pocketCorners = fillet(pocket.sides().edges().parallel(Z), { r: 5 });

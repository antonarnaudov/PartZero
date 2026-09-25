import { doc, part, sketch, extrude, rect, XY } from "@aicad/std";

doc({ name: "desk_tray_block", description: "60x40x20 block with a 30x20x10 pocket in the top" });

part("block");
const outline = sketch(XY, { outline: rect({ center: [0, 0], w: 60, h: 40 }) });
const block = extrude(outline, { distance: 20 });
const pocketSk = sketch(block.cap("end"), { pocket: rect({ center: [0, 0], w: 30, h: 20 }) });
const pocket = extrude(pocketSk, { distance: 10, direction: "reverse", op: "cut", targets: block });

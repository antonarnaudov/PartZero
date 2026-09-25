import { doc, part, sketch, extrude, rect, XY } from "@aicad/std";

doc({ name: "gridfinity_cell", description: "Simplified 1x1 Gridfinity-style baseplate frame: 42x42 R4 outside, 36x36 R1 opening, 5 tall" });

part("baseplate");
const frame_outline = sketch(XY, {
  outer: rect({ center: [0, 0], w: 42, h: 42, r: 4 }),
  opening: rect({ center: [0, 0], w: 36, h: 36, r: 1 }),
});
const cell = extrude(frame_outline, { distance: 5 });

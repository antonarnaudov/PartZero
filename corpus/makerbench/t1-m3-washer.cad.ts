import { doc, part, sketch, circle, extrude, XY } from "@aicad/std";

doc({ name: "m3_washer", description: "M3 washer: 3.2 mm hole, 7 mm OD, 1 mm thick" });

part("washer");
const outline = sketch(XY, {
  rim: circle({ center: [0, 0], radius: 3.5 }),
  bore: circle({ center: [0, 0], radius: 1.6 }),
});
const washer = extrude(outline, { distance: 1 });

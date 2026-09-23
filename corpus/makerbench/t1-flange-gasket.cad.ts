import { doc, part, sketch, circle, extrude, XY } from "@aicad/std";

doc({ name: "flange_gasket", description: "Flange gasket: 60 OD, 40 ID, 4x 4.5 mm holes on a 50 mm bolt circle, 2 mm thick" });

part("gasket");
const outline = sketch(XY, {
  outer: circle({ center: [0, 0], radius: 30 }),
  inner: circle({ center: [0, 0], radius: 20 }),
  bolt_e: circle({ center: [25, 0], radius: 2.25 }),
  bolt_n: circle({ center: [0, 25], radius: 2.25 }),
  bolt_w: circle({ center: [-25, 0], radius: 2.25 }),
  bolt_s: circle({ center: [0, -25], radius: 2.25 }),
});
const gasket = extrude(outline, { distance: 2 });

import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "rpi4_plate", description: "Raspberry Pi 4 mounting plate: 85x56x3, 4x 2.7 mm holes on the 58x49 pattern" });

part("plate");
const outline = sketch(XY, {
  bottom: line([0, 0], [85, 0]),
  right: line([85, 0], [85, 56]),
  top: line([85, 56], [0, 56]),
  left: line([0, 56], [0, 0]),
  h_bl: circle({ center: [3.5, 3.5], radius: 1.35 }),
  h_br: circle({ center: [61.5, 3.5], radius: 1.35 }),
  h_tr: circle({ center: [61.5, 52.5], radius: 1.35 }),
  h_tl: circle({ center: [3.5, 52.5], radius: 1.35 }),
});
const plate = extrude(outline, { distance: 3 });

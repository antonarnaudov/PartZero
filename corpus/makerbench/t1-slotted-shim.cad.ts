import { doc, part, sketch, line, arc, extrude, XY } from "@aicad/std";

doc({ name: "slotted_shim", description: "Motor mount shim: 40x20x1 with two 5.5x12 slots 20 mm apart" });

part("shim");
const outline = sketch(XY, {
  bottom: line([-20, -10], [20, -10]),
  right: line([20, -10], [20, 10]),
  top: line([20, 10], [-20, 10]),
  left: line([-20, 10], [-20, -10]),
  a_low: line([-13.25, -2.75], [-6.75, -2.75]),
  a_end_r: arc({ start: [-6.75, -2.75], end: [-6.75, 2.75], center: [-6.75, 0], ccw: true }),
  a_up: line([-6.75, 2.75], [-13.25, 2.75]),
  a_end_l: arc({ start: [-13.25, 2.75], end: [-13.25, -2.75], center: [-13.25, 0], ccw: true }),
  b_low: line([6.75, -2.75], [13.25, -2.75]),
  b_end_r: arc({ start: [13.25, -2.75], end: [13.25, 2.75], center: [13.25, 0], ccw: true }),
  b_up: line([13.25, 2.75], [6.75, 2.75]),
  b_end_l: arc({ start: [6.75, 2.75], end: [6.75, -2.75], center: [6.75, 0], ccw: true }),
});
const shim = extrude(outline, { distance: 1 });

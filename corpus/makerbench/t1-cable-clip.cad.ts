import { doc, part, sketch, line, arc, extrude, XY } from "@aicad/std";

doc({ name: "cable_clip", description: "Stick-on C clip for a 6 mm cable: 1.5 mm wall, 4 mm opening, 20x2 foot, 8 mm wide" });

part("clip");
// Ring centre at the origin, 6 mm above the underside of the foot (y = -6).
// Inner radius 3, outer radius 4.5; the opening's inner corners are at x = +-2 (4 mm gap),
// and the lip faces are radial. The outer ring meets the top of the foot (y = -4) at x = +-sqrt(4.25).
const profile = sketch(XY, {
  foot_bottom: line([-10, -6], [10, -6]),
  foot_right: line([10, -6], [10, -4]),
  foot_top_r: line([10, -4], [2.0615528128088303, -4]),
  outer_r: arc({ start: [2.0615528128088303, -4], end: [3, 3.3541019662496847], center: [0, 0], ccw: true }),
  lip_r: line([3, 3.3541019662496847], [2, 2.23606797749979]),
  seat: arc({ start: [2, 2.23606797749979], end: [-2, 2.23606797749979], center: [0, 0], ccw: false }),
  lip_l: line([-2, 2.23606797749979], [-3, 3.3541019662496847]),
  outer_l: arc({ start: [-3, 3.3541019662496847], end: [-2.0615528128088303, -4], center: [0, 0], ccw: true }),
  foot_top_l: line([-2.0615528128088303, -4], [-10, -4]),
  foot_left: line([-10, -4], [-10, -6]),
});
const clip = extrude(profile, { distance: 8 });

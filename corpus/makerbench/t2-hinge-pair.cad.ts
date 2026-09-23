import { doc, part, sketch, line, arc, circle, extrude, frame, XY } from "@aicad/std";

doc({ name: "hinge_pair", description: "Print-in-place butt hinge blank: two 30 x 30 x 2.5 leaves, 7 mm knuckles (A: two outer, B: middle) with 0.3 mm gaps, 2.2 mm pin hole on Z" });

// Pin axis = Z axis. Leaves lie flat (open 180°) between Y = -3.5 and Y = -1, flush with the
// knuckle's bottom. A knuckle profile = the 7 mm knuckle disc plus its leaf; the knuckle circle
// meets the leaf's top face (Y = -1) at x = sqrt(3.5^2 - 1).
part("leaf_a");
const a_knuckle_low_profile = sketch(XY, {
  bottom: line([30, -3.5], [0, -3.5]),
  knuckle: arc({ start: [0, -3.5], end: [3.3541019662496847, -1], center: [0, 0], ccw: false }),
  top: line([3.3541019662496847, -1], [30, -1]),
  edge: line([30, -1], [30, -3.5]),
  pin: circle({ center: [0, 0], radius: 1.1 }),
});
const a_knuckle_low = extrude(a_knuckle_low_profile, { distance: 10 });
// Where leaf B's knuckle is, leaf A's plate stops 0.3 mm short of it (3.8 mm from the axis).
const a_plate_mid_profile = sketch(frame({ origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  bottom: line([3.8, -3.5], [30, -3.5]),
  edge: line([30, -3.5], [30, -1]),
  top: line([30, -1], [3.8, -1]),
  inner: line([3.8, -1], [3.8, -3.5]),
});
const a_plate_mid = extrude(a_plate_mid_profile, { distance: 10 });
const a_knuckle_high_profile = sketch(frame({ origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  bottom: line([30, -3.5], [0, -3.5]),
  knuckle: arc({ start: [0, -3.5], end: [3.3541019662496847, -1], center: [0, 0], ccw: false }),
  top: line([3.3541019662496847, -1], [30, -1]),
  edge: line([30, -1], [30, -3.5]),
  pin: circle({ center: [0, 0], radius: 1.1 }),
});
const a_knuckle_high = extrude(a_knuckle_high_profile, { distance: 10 });

part("leaf_b");
const b_plate_low_profile = sketch(XY, {
  bottom: line([-30, -3.5], [-3.8, -3.5]),
  inner: line([-3.8, -3.5], [-3.8, -1]),
  top: line([-3.8, -1], [-30, -1]),
  edge: line([-30, -1], [-30, -3.5]),
});
const b_plate_low = extrude(b_plate_low_profile, { distance: 10.3 });
// Middle knuckle: 0.3 mm axial gap to leaf A's knuckles on both sides (Z 10.3 to 19.7).
const b_knuckle_profile = sketch(frame({ origin: [0, 0, 10.3], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  bottom: line([-30, -3.5], [0, -3.5]),
  knuckle: arc({ start: [0, -3.5], end: [-3.3541019662496847, -1], center: [0, 0], ccw: true }),
  top: line([-3.3541019662496847, -1], [-30, -1]),
  edge: line([-30, -1], [-30, -3.5]),
  pin: circle({ center: [0, 0], radius: 1.1 }),
});
const b_knuckle = extrude(b_knuckle_profile, { distance: 9.4 });
const b_plate_high_profile = sketch(frame({ origin: [0, 0, 19.7], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  bottom: line([-30, -3.5], [-3.8, -3.5]),
  inner: line([-3.8, -3.5], [-3.8, -1]),
  top: line([-3.8, -1], [-30, -1]),
  edge: line([-30, -1], [-30, -3.5]),
});
const b_plate_high = extrude(b_plate_high_profile, { distance: 10.3 });

import { doc, part, sketch, line, arc, circle, extrude, frame, XY, XZ } from "@aicad/std";

doc({ name: "bearing_block_pair", description: "Two 608 bearing blocks for an 8 mm shaft along Y at Z = 25, 100 mm apart: 60x20x5 feet with 2x M5, 40x8 rounded uprights with 22.1 seats" });

part("block_a");
const foot_a_outline = sketch(XY, {
  bottom: line([-30, -10], [30, -10]),
  right: line([30, -10], [30, 10]),
  top: line([30, 10], [-30, 10]),
  left: line([-30, 10], [-30, -10]),
  m5_l: circle({ center: [-22, 0], radius: 2.75 }),
  m5_r: circle({ center: [22, 0], radius: 2.75 }),
});
const foot_a = extrude(foot_a_outline, { distance: 5 });
// Upright in XZ (u = x, v = z), 8 mm thick centred on Y = 0; the top is a half circle round the shaft.
const upright_a_outline = sketch(XZ, {
  u_bottom: line([-20, 5], [20, 5]),
  u_right: line([20, 5], [20, 25]),
  u_top: arc({ start: [20, 25], end: [-20, 25], center: [0, 25], ccw: true }),
  u_left: line([-20, 25], [-20, 5]),
  // 608 bearing: 22 mm OD; 22.1 for a light press fit.
  seat: circle({ center: [0, 25], radius: 11.05 }),
});
const upright_a = extrude(upright_a_outline, { distance: 8, direction: "symmetric" });

part("block_b");
const foot_b_outline = sketch(XY, {
  b_bottom: line([-30, 90], [30, 90]),
  b_right: line([30, 90], [30, 110]),
  b_top: line([30, 110], [-30, 110]),
  b_left: line([-30, 110], [-30, 90]),
  b_m5_l: circle({ center: [-22, 100], radius: 2.75 }),
  b_m5_r: circle({ center: [22, 100], radius: 2.75 }),
});
const foot_b = extrude(foot_b_outline, { distance: 5 });
// Same upright on a plane parallel to XZ through Y = 100 (normal −Y like XZ, so v = +Z).
const upright_b_outline = sketch(frame({ origin: [0, 100, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }), {
  b_u_bottom: line([-20, 5], [20, 5]),
  b_u_right: line([20, 5], [20, 25]),
  b_u_top: arc({ start: [20, 25], end: [-20, 25], center: [0, 25], ccw: true }),
  b_u_left: line([-20, 25], [-20, 5]),
  b_seat: circle({ center: [0, 25], radius: 11.05 }),
});
const upright_b = extrude(upright_b_outline, { distance: 8, direction: "symmetric" });

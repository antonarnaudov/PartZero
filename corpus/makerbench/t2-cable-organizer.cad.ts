import { doc, part, sketch, line, arc, circle, extrude, frame, XY } from "@aicad/std";

doc({ name: "cable_organizer", description: "Desk cable organiser: 90x20x3 base with 2x M4, five snap-in C clips for 5 mm cables on a 15 mm pitch" });

part("organizer");
const base_outline = sketch(XY, {
  bottom: line([-45, -10], [45, -10]),
  right: line([45, -10], [45, 10]),
  top: line([45, 10], [-45, 10]),
  left: line([-45, 10], [-45, -10]),
  m4_l: circle({ center: [-40, 0], radius: 2.25 }),
  m4_r: circle({ center: [40, 0], radius: 2.25 }),
});
const base = extrude(base_outline, { distance: 3 });
// Clip profiles on a plane parallel to XZ through Y = 5 (normal −Y, so u = X and v = Z), extruded
// 10 mm to Y = −5. Each clip: 5.2 mm seat, 1.5 mm wall, ring centre 3.5 mm above the base top
// (Z = 6.5), so the ring's flat bottom sits on the base; 3.6 mm opening with radial lip faces.
const clip_profiles = sketch(frame({ origin: [0, 5, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }), {
  c1_bottom: line([-32.13541565040626, 3], [-27.864584349593738, 3]),
  c1_outer_r: arc({ start: [-27.864584349593738, 3], end: [-27.161538461538463, 9.458569940811701], center: [-30, 6.5], ccw: true }),
  c1_lip_r: line([-27.161538461538463, 9.458569940811701], [-28.2, 8.376166303929372]),
  c1_seat: arc({ start: [-28.2, 8.376166303929372], end: [-31.8, 8.376166303929372], center: [-30, 6.5], ccw: false }),
  c1_lip_l: line([-31.8, 8.376166303929372], [-32.83846153846154, 9.458569940811701]),
  c1_outer_l: arc({ start: [-32.83846153846154, 9.458569940811701], end: [-32.13541565040626, 3], center: [-30, 6.5], ccw: true }),
  c2_bottom: line([-17.135415650406262, 3], [-12.864584349593738, 3]),
  c2_outer_r: arc({ start: [-12.864584349593738, 3], end: [-12.161538461538463, 9.458569940811701], center: [-15, 6.5], ccw: true }),
  c2_lip_r: line([-12.161538461538463, 9.458569940811701], [-13.2, 8.376166303929372]),
  c2_seat: arc({ start: [-13.2, 8.376166303929372], end: [-16.8, 8.376166303929372], center: [-15, 6.5], ccw: false }),
  c2_lip_l: line([-16.8, 8.376166303929372], [-17.838461538461537, 9.458569940811701]),
  c2_outer_l: arc({ start: [-17.838461538461537, 9.458569940811701], end: [-17.135415650406262, 3], center: [-15, 6.5], ccw: true }),
  c3_bottom: line([-2.135415650406262, 3], [2.135415650406262, 3]),
  c3_outer_r: arc({ start: [2.135415650406262, 3], end: [2.838461538461538, 9.458569940811701], center: [0, 6.5], ccw: true }),
  c3_lip_r: line([2.838461538461538, 9.458569940811701], [1.8, 8.376166303929372]),
  c3_seat: arc({ start: [1.8, 8.376166303929372], end: [-1.8, 8.376166303929372], center: [0, 6.5], ccw: false }),
  c3_lip_l: line([-1.8, 8.376166303929372], [-2.838461538461538, 9.458569940811701]),
  c3_outer_l: arc({ start: [-2.838461538461538, 9.458569940811701], end: [-2.135415650406262, 3], center: [0, 6.5], ccw: true }),
  c4_bottom: line([12.864584349593738, 3], [17.135415650406262, 3]),
  c4_outer_r: arc({ start: [17.135415650406262, 3], end: [17.838461538461537, 9.458569940811701], center: [15, 6.5], ccw: true }),
  c4_lip_r: line([17.838461538461537, 9.458569940811701], [16.8, 8.376166303929372]),
  c4_seat: arc({ start: [16.8, 8.376166303929372], end: [13.2, 8.376166303929372], center: [15, 6.5], ccw: false }),
  c4_lip_l: line([13.2, 8.376166303929372], [12.161538461538463, 9.458569940811701]),
  c4_outer_l: arc({ start: [12.161538461538463, 9.458569940811701], end: [12.864584349593738, 3], center: [15, 6.5], ccw: true }),
  c5_bottom: line([27.864584349593738, 3], [32.13541565040626, 3]),
  c5_outer_r: arc({ start: [32.13541565040626, 3], end: [32.83846153846154, 9.458569940811701], center: [30, 6.5], ccw: true }),
  c5_lip_r: line([32.83846153846154, 9.458569940811701], [31.8, 8.376166303929372]),
  c5_seat: arc({ start: [31.8, 8.376166303929372], end: [28.2, 8.376166303929372], center: [30, 6.5], ccw: false }),
  c5_lip_l: line([28.2, 8.376166303929372], [27.161538461538463, 9.458569940811701]),
  c5_outer_l: arc({ start: [27.161538461538463, 9.458569940811701], end: [27.864584349593738, 3], center: [30, 6.5], ccw: true }),
});
const clips = extrude(clip_profiles, { distance: 10 });

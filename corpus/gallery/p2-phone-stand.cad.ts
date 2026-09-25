import { doc, part, sketch, extrude, frame, line, arc, rect, cos, sin, XY, param } from "@aicad/std";

doc({ name: "phone_stand", description: "P2: a desk phone stand that holds a phone at about 65°, with a cable notch; printed on its side" });

// Assumptions from a vague prompt, each one a parameter (ALPHA-0-PLAN §2.4 P2).
const angle = param(65, { unit: "deg", min: 60, max: 70, note: "phone angle from the desk" });
const phone_slot = param(12, { min: 8, max: 20, note: "phone thickness with its case, plus play" });
const width = param(70, { min: 60, max: 120, note: "stand width (along Z when printed)" });
const wall = param(6, { min: 4, max: 10, note: "thickness of the foot, lip, support and post" });
const lip_h = param(18, { min: 12, max: 30, note: "lip height from the desk" });
const lip_r = param(2, { min: 0.5, max: 2.9, note: "rounding of the lip's top edges" });
const support = param(120, { min: 100, max: 135, note: "length of the leaning support" });
const post_at = param(0.8, { unit: "ratio", min: 0.6, max: 0.9, note: "where the back post meets the support" });
const notch_w = param(14, { min: 12, max: 30, note: "cable notch width" });

part("stand");
// Derived geometry: the support leans back at `angle`; the post and the foot close a triangle.
const ca = param(cos(angle), { unit: "ratio" });
const sa = param(sin(angle), { unit: "ratio" });
const bx = param(wall + phone_slot);
const tx = param(bx + support * ca);
const ty = param(wall + support * sa);
const qx = param(bx + wall * sa + post_at * support * ca);
const qy = param(wall - wall * ca + post_at * support * sa);
const w1x = param(bx + wall / sa);
const w3y = param(wall - wall * ca + (post_at * support - wall / ca) * sa);

const profile = sketch(XY, {
  foot: line([0, 0], [qx, 0]),
  post: line([qx, 0], [qx, qy]),
  back: line([qx, qy], [tx + wall * sa, ty - wall * ca]),
  top: line([tx + wall * sa, ty - wall * ca], [tx, ty]),
  front: line([tx, ty], [bx, wall]),
  groove: line([bx, wall], [wall, wall]),
  lip_back: line([wall, wall], [wall, lip_h - lip_r]),
  lip_round_back: arc({ start: [wall, lip_h - lip_r], end: [wall - lip_r, lip_h], center: [wall - lip_r, lip_h - lip_r], ccw: true }),
  lip_top: line([wall - lip_r, lip_h], [lip_r, lip_h]),
  lip_round_front: arc({ start: [lip_r, lip_h], end: [0, lip_h - lip_r], center: [lip_r, lip_h - lip_r], ccw: true }),
  lip_front: line([0, lip_h - lip_r], [0, 0]),
  window_floor: line([w1x, wall], [qx - wall, wall]),
  window_post: line([qx - wall, wall], [qx - wall, w3y]),
  window_support: line([qx - wall, w3y], [w1x, wall]),
});
const stand = extrude(profile, { distance: width });

// The cable leaves the phone's port forward: a notch through the lip and into the groove floor.
const notch_sk = sketch(frame({ origin: [-1, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }), {
  notch: rect({ corner: [wall / 2, width / 2 - notch_w / 2], w: lip_h, h: notch_w }),
});
const notch = extrude(notch_sk, { distance: 1 + wall + phone_slot / 2, op: "cut", targets: stand });

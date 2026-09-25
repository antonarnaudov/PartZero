import { doc, part, param, sketch, extrude, line, C, XZ } from "@aicad/std";

doc({ name: "constrained_l_bracket", description: "Fully constrained L bracket profile driven by leg_a, leg_b and thick, 30 mm wide" });

const leg_a = param(50, { min: 20, note: "floor leg length (X)" });
const leg_b = param(35, { min: 20, note: "upright height (Z)" });
const thick = param(5, { min: 2, max: 10, note: "material thickness" });

part("bracket");
const profile = sketch(XZ, {
  bottom: line([0, 0], [50, 0]),
  toe: line([50, 0], [50, 5]),
  shelf: line([50, 5], [5, 5]),
  inner: line([5, 5], [5, 35]),
  cap: line([5, 35], [0, 35]),
  back: line([0, 35], [0, 0]),
}, {
  constraints: {
    h_bottom: C.horizontal("bottom"),
    h_shelf: C.horizontal("shelf"),
    h_cap: C.horizontal("cap"),
    v_toe: C.vertical("toe"),
    v_inner: C.vertical("inner"),
    v_back: C.vertical("back"),
    origin: C.fix("bottom.start"),
    len_a: C.distance("bottom.start", "bottom.end", leg_a),
    len_b: C.distance("back.start", "back.end", leg_b),
    t_toe: C.distance("toe.start", "toe.end", thick),
    t_cap: C.distance("cap.start", "cap.end", thick),
  },
});
const bracket = extrude(profile, { distance: 30, direction: "symmetric" });

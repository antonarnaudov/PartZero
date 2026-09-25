import { doc, part, param, sketch, extrude, line, circle, C, XY } from "@aicad/std";

doc({ name: "constrained_gusset", description: "Right-triangle gusset 40x30x5 with an M4 hole 8 mm from both legs, fully constrained" });

const base_len = param(40, { min: 25, note: "horizontal leg" });
const rise = param(30, { min: 20, note: "vertical leg" });

part("gusset");
const profile = sketch(XY, {
  base: line([0, 0], [40, 0]),
  hyp: line([40, 0], [0, 30]),
  upright: line([0, 30], [0, 0]),
  bolt: circle({ center: [8, 8], radius: 2.25 }),
}, {
  constraints: {
    h_base: C.horizontal("base"),
    v_upright: C.vertical("upright"),
    corner: C.fix("base.start"),
    len_base: C.distance("base.start", "base.end", base_len),
    len_rise: C.distance("upright.start", "upright.end", rise),
    bolt_x: C.distance("bolt.center", "upright", 8),
    bolt_y: C.distance("bolt.center", "base", 8),
    bolt_r: C.diameter("bolt", 4.5),
  },
});
const gusset = extrude(profile, { distance: 5 });

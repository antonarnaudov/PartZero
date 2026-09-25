import { doc, part, param, sketch, extrude, line, circle, C, XY } from "@aicad/std";

doc({ name: "constrained_hanger_plate", description: "Fully constrained 60x40 hanger plate, two symmetric M4 holes 10 mm below the top" });

const width = param(60, { min: 30, note: "plate width" });
const height = param(40, { min: 25, note: "plate height" });
const spacing = param(40, { min: 10, note: "hole spacing" });

part("hanger");
const profile = sketch(XY, {
  bottom: line([0, 0], [60, 0]),
  right: line([60, 0], [60, 40]),
  top: line([60, 40], [0, 40]),
  left: line([0, 40], [0, 0]),
  axis: line([30, 0], [30, 40], { construction: true }),
  h1: circle({ center: [10, 30], radius: 2.25 }),
  h2: circle({ center: [50, 30], radius: 2.25 }),
}, {
  constraints: {
    h_bottom: C.horizontal("bottom"),
    h_top: C.horizontal("top"),
    v_left: C.vertical("left"),
    v_right: C.vertical("right"),
    corner: C.fix("bottom.start"),
    w: C.distance("bottom.start", "bottom.end", width),
    h: C.distance("left.start", "left.end", height),
    axis_lo: C.midpoint("axis.start", "bottom"),
    axis_hi: C.midpoint("axis.end", "top"),
    mirror_holes: C.symmetric("h1.center", "h2.center", "axis"),
    pitch: C.distance("h1.center", "h2.center", spacing),
    drop: C.distance("h1.center", "top", 10),
    same: C.equal("h1", "h2"),
    size: C.diameter("h1", 4.5),
  },
});
const hanger = extrude(profile, { distance: 4 });

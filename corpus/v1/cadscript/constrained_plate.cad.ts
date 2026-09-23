import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ, param, point, C } from "@aicad/std";

doc({ name: "constrained_plate", description: "SPEC-v1 §4.6: a fully constrained rectangle whose dimensions are bound to parameters" });

const width = param(80);
const depth = param(50);

part("plate");
const base = sketch(XY, {
  bottom: line([-40, -25], [40, -25]),
  right: line([40, -25], [40, 25]),
  top: line([40, 25], [-40, 25]),
  left: line([-40, 25], [-40, -25]),
  o: point([0, 0]),
  diag: line([-40, -25], [40, 25], { construction: true }),
}, {
  constraints: {
    h1: C.horizontal("bottom"),
    h2: C.horizontal("top"),
    v1: C.vertical("left"),
    v2: C.vertical("right"),
    w: C.distance("bottom.start", "bottom.end", width),
    d: C.distance("left.start", "left.end", depth),
    mid: C.midpoint("o", "diag"),
    pin: C.fix("o"),
    ref_diag: C.distance("diag.start", "diag.end", { driving: false }),
  },
});
const slab = extrude(base, { distance: 6, regions: ["bottom"] });

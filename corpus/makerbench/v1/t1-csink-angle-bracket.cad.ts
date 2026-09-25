import { doc, part, sketch, extrude, line, fillet, hole, edgesBetween, XZ } from "@aicad/std";

doc({ name: "csink_angle_bracket", description: "L bracket 50x40x40, 5 mm thick, R4 inside fillet, two ISO 10642 countersunk M4 holes per leg" });

part("bracket");
// Side profile in XZ (u = X, v = Z), extruded 20 mm each side of XZ.
const profile = sketch(XZ, {
  bottom: line([0, 0], [50, 0]),
  toe: line([50, 0], [50, 5]),
  shelf: line([50, 5], [5, 5]),
  inner: line([5, 5], [5, 40]),
  cap: line([5, 40], [0, 40]),
  back: line([0, 40], [0, 0]),
});
const bracket = extrude(profile, { distance: 40, direction: "symmetric" });
const corner = fillet(edgesBetween(bracket.side("shelf"), bracket.side("inner")), { r: 4 });
const shelfHoles = hole(bracket.side("shelf"), { at: { a: [30, -10], b: [30, 10] }, size: "M4", depth: "through", csink: "iso10642" });
const wallHoles = hole(bracket.side("inner"), { at: { c: [-10, 25], d: [10, 25] }, size: "M4", depth: "through", csink: "iso10642" });

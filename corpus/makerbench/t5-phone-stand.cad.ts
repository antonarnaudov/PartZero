import { doc, part, sketch, line, extrude, XZ } from "@aicad/std";

// Assumed: a typical 6.5" phone in a case (~12 mm thick), portrait, leaning back ~23 degrees.
doc({ name: "phone_stand", description: "Assumed defaults: one-piece side profile (90 deep, 66 tall) extruded 75 mm, 12 mm phone slot" });

part("stand");
const profile = sketch(XZ, {
  base_bottom: line([0, 0], [90, 0]),
  base_back: line([90, 0], [90, 6]),
  back_slope: line([90, 6], [52, 66]),
  rest_top: line([52, 66], [44, 66]),
  rest_face: line([44, 66], [18, 6]),
  slot_floor: line([18, 6], [6, 6]),
  lip_inner: line([6, 6], [6, 16]),
  lip_top: line([6, 16], [0, 16]),
  front: line([0, 16], [0, 0]),
});
const stand = extrude(profile, { distance: 75 });

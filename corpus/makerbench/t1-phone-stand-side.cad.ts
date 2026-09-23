import { doc, part, sketch, line, extrude, XZ } from "@aicad/std";

doc({ name: "phone_stand", description: "One-piece phone stand: side profile (90 deep, 66 tall) extruded 70 mm" });

part("stand");
// Side profile in XZ: x = depth from the front edge, z = height.
const profile = sketch(XZ, {
  base_bottom: line([0, 0], [90, 0]),
  base_back: line([90, 0], [90, 6]),
  back_slope: line([90, 6], [50, 66]),
  rest_top: line([50, 66], [42, 66]),
  rest_face: line([42, 66], [16, 6]),
  slot_floor: line([16, 6], [6, 6]),
  lip_inner: line([6, 6], [6, 16]),
  lip_top: line([6, 16], [0, 16]),
  front: line([0, 16], [0, 0]),
});
const stand = extrude(profile, { distance: 70 });

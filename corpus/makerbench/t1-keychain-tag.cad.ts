import { doc, part, sketch, line, arc, circle, extrude, XY } from "@aicad/std";

doc({ name: "keychain_tag", description: "Stadium keychain tag 50x20x3 with a 5 mm ring hole 8 mm from one end" });

part("tag");
const outline = sketch(XY, {
  bottom: line([-15, -10], [15, -10]),
  end_r: arc({ start: [15, -10], end: [15, 10], center: [15, 0], ccw: true }),
  top: line([15, 10], [-15, 10]),
  end_l: arc({ start: [-15, 10], end: [-15, -10], center: [-15, 0], ccw: true }),
  ring_hole: circle({ center: [-17, 0], radius: 2.5 }),
});
const tag = extrude(outline, { distance: 3 });

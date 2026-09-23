import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "bearing_housing_608", description: "608 bearing housing: 30 OD, 8 tall, 22x7 pocket from the top, 1 mm lip with 19 mm hole" });

part("housing");
const profile = sketch(XZ, {
  bottom: line([9.5, 0], [15, 0]),
  outer: line([15, 0], [15, 8]),
  top: line([15, 8], [11, 8]),
  pocket_wall: line([11, 8], [11, 1]),
  lip_top: line([11, 1], [9.5, 1]),
  lip_bore: line([9.5, 1], [9.5, 0]),
});
const housing = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

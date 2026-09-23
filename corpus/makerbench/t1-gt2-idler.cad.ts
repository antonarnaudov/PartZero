import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "gt2_idler", description: "Flanged GT2 idler for a 608 bearing: 22 bore, 26 belt diameter, 7 mm belt width, 32 mm flanges" });

part("idler");
const profile = sketch(XZ, {
  bottom: line([11, 0], [16, 0]),
  flange1_rim: line([16, 0], [16, 1]),
  flange1_top: line([16, 1], [13, 1]),
  belt_seat: line([13, 1], [13, 8]),
  flange2_bottom: line([13, 8], [16, 8]),
  flange2_rim: line([16, 8], [16, 9]),
  top: line([16, 9], [11, 9]),
  bore: line([11, 9], [11, 0]),
});
const idler = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

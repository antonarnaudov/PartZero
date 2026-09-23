import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "flanged_bushing", description: "Flanged bushing for 8 mm rod: 8.1 bore, 12 OD, 15 long, 18x2 flange" });

part("bushing");
const profile = sketch(XZ, {
  bottom: line([4.05, 0], [9, 0]),
  flange_rim: line([9, 0], [9, 2]),
  flange_top: line([9, 2], [6, 2]),
  body: line([6, 2], [6, 15]),
  top: line([6, 15], [4.05, 15]),
  bore: line([4.05, 15], [4.05, 0]),
});
const bushing = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "desk_grommet", description: "Desk cable grommet: 60 OD x 2 wall x 20 tube, 70x3 flange on top" });

part("grommet");
const profile = sketch(XZ, {
  bottom: line([28, 0], [30, 0]),
  tube_outer: line([30, 0], [30, 20]),
  flange_under: line([30, 20], [35, 20]),
  flange_rim: line([35, 20], [35, 23]),
  top: line([35, 23], [28, 23]),
  tube_inner: line([28, 23], [28, 0]),
});
const grommet = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "pipe_collar", description: "Half collar (180°) for a 25 mm pipe: 25.6 bore, 36 OD x 15 tall, 44 mm x 3 mm flange; print two and clamp them round the pipe" });

part("collar");
// Half profile in XZ (u = radius, v = height), revolved about the Z axis.
const profile = sketch(XZ, {
  bottom: line([12.8, 0], [22, 0]),
  flange_rim: line([22, 0], [22, 3]),
  flange_top: line([22, 3], [18, 3]),
  outer: line([18, 3], [18, 15]),
  top: line([18, 15], [12.8, 15]),
  bore: line([12.8, 15], [12.8, 0]),
});
const collar = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 180 });

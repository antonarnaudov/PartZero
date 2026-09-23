import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

// Assumed: a pot for a small succulent from a 5.5 cm nursery pot, with drainage, no saucer.
doc({ name: "succulent_pot", description: "Assumed defaults: tapered pot 65 → 80 mm dia, 70 tall, 2.5 mm walls, 3 mm floor with a 10 mm drainage hole" });

part("pot");
// Half profile in XZ (u = radius, v = height). The inner wall is the outer one moved 2.5 mm in:
// at the floor top (z = 3) its radius is 32.5 + 7.5·3/70 − 2.5.
const profile = sketch(XZ, {
  bottom: line([5, 0], [32.5, 0]),
  outer: line([32.5, 0], [40, 70]),
  rim: line([40, 70], [37.5, 70]),
  inner: line([37.5, 70], [30.32142857142857, 3]),
  floor_top: line([30.32142857142857, 3], [5, 3]),
  drain: line([5, 3], [5, 0]),
});
const pot = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

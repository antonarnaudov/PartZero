import { doc, part, sketch, extrude, line, hole, linearPattern, XY } from "@aicad/std";
doc({ name: "trapezoid_cap_edge_dir" });
part("t");
const ts = sketch(XY, {
  l1: line([0, 0], [60, 0]),
  ls: line([60, 0], [40, 30]),
  l3: line([40, 30], [0, 30]),
  l4: line([0, 30], [0, 0]),
});
const t = extrude(ts, { distance: 5 });
const h = hole(t.cap("end"), { at: { a: [30, 10] }, d: 4, depth: "through" });
const p = linearPattern([h], { dir: [20, -30, 0], count: 2, spacing: 5 });

import { doc, part, sketch, extrude, line, arc, hole, circularPattern, XY } from "@aicad/std";
doc({ name: "quarter_disc_junction_axis" });
part("q");
const qs = sketch(XY, {
  l1: line([0, 0], [40, 0]),
  a1: arc({ start: [40, 0], end: [0, 40], center: [0, 0], ccw: true }),
  l2: line([0, 40], [0, 0]),
});
const q = extrude(qs, { distance: 5 });
const h = hole(q.cap("end"), { at: { a: [30, 10] }, d: 4, depth: "through" });
const p = circularPattern([h], { axis: { line: { origin: [40, 0, 0], direction: [0, 0, 1] } }, count: 2, angle: 30 });

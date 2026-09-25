import { doc, part, sketch, extrude, rect, fillet, hole, XY, Z } from "@aicad/std";

doc({ name: "ops_hole_plate", description: "Naming harness (holes, fillets): 100x60x10 plate, R5 vertical corners, three Ø6 holes and an M4 counterbore" });

part("plate");
const base = sketch(XY, { outline: rect({ center: [0, 0], w: 100, h: 60 }) });
const plate = extrude(base, { distance: 10 });
const corners = fillet(plate.sides().edges().parallel(Z), { r: 5 });
const holes = hole(plate.cap("end"), { at: { a: [-30, -15], b: [30, -15], c: [0, 15] }, d: 6, depth: "through" });
const screw = hole(plate.cap("end"), { at: { m: [-30, 15] }, size: "M4", depth: "through", cbore: "iso4762" });

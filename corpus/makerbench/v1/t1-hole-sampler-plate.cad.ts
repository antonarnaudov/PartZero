import { doc, part, sketch, extrude, rect, hole, XY } from "@aicad/std";

doc({ name: "hole_sampler_plate", description: "120x40x10 test coupon: plain 5 mm, M3 counterbore, M4 countersink and M3 heat-set insert holes" });

part("coupon");
const outline = sketch(XY, { plate: rect({ center: [0, 0], w: 120, h: 40 }) });
const coupon = extrude(outline, { distance: 10 });
const plain = hole(coupon.cap("end"), { at: { p: [-45, 0] }, d: 5, depth: "through" });
const cbored = hole(coupon.cap("end"), { at: { c: [-15, 0] }, size: "M3", depth: "through", cbore: "iso4762" });
const csunk = hole(coupon.cap("end"), { at: { k: [15, 0] }, size: "M4", depth: "through", csink: "iso10642" });
const insert = hole(coupon.cap("end"), { at: { i: [45, 0] }, size: "M3", insert: "std" });

import { doc, part, sketch, extrude, circle, chamfer, hole, XY } from "@aicad/std";

doc({ name: "knob", description: "Round knob: 30 mm dia, 15 tall, 6 mm bore 10 deep from below, 2 mm top chamfer" });

part("knob");
const disc = sketch(XY, { rim: circle({ center: [0, 0], radius: 15 }) });
const knob = extrude(disc, { distance: 15 });
const topEdge = chamfer(knob.cap("end").edges(), { d: 2 });
const shaft = hole(knob.cap("start"), { at: { axis: [0, 0] }, d: 6, depth: { blind: 10 }, tip: "flat" });

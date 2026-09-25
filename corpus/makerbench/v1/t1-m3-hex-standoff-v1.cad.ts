import { doc, part, sketch, extrude, polygon, hole, XY } from "@aicad/std";

doc({ name: "m3_hex_standoff", description: "Hex standoff: 5.5 mm across flats, 12 mm tall, tapped M3 through" });

part("standoff");
const hexSk = sketch(XY, { hex: polygon({ n: 6, acrossFlats: 5.5 }) });
const standoff = extrude(hexSk, { distance: 12 });
const tapped = hole(standoff.cap("end"), { at: { axis: [0, 0] }, size: "M3", thread: true, depth: "through" });

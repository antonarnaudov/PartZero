import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "screw_size_gauge", description: "Laser-cut 3 mm acrylic screw gauge: 120x25 strip, M2–M8 clearance holes 15 mm apart on the centre line" });

part("gauge");
const strip = sketch(XY, {
  bottom: line([0, 0], [120, 0]),
  right: line([120, 0], [120, 25]),
  top: line([120, 25], [0, 25]),
  left: line([0, 25], [0, 0]),
  m2: circle({ center: [12, 12.5], radius: 1.2 }),
  m2_5: circle({ center: [27, 12.5], radius: 1.45 }),
  m3: circle({ center: [42, 12.5], radius: 1.7 }),
  m4: circle({ center: [57, 12.5], radius: 2.25 }),
  m5: circle({ center: [72, 12.5], radius: 2.75 }),
  m6: circle({ center: [87, 12.5], radius: 3.3 }),
  m8: circle({ center: [102, 12.5], radius: 4.5 }),
});
const gauge = extrude(strip, { distance: 3 });

import { doc, part, sketch, extrude, shell, circle, XY } from "@aicad/std";

doc({ name: "jar_with_lid", description: "50x40 jar (2 mm wall and floor) and a press-fit lid with a 45.6 mm plug ring, side by side" });

part("jar");
const jarSk = sketch(XY, { outside: circle({ center: [0, 0], radius: 25 }) });
const jar = extrude(jarSk, { distance: 40 });
const hollow = shell(jar, { open: jar.cap("end"), thickness: 2 });

part("lid");
const lidSk = sketch(XY, { disc: circle({ center: [60, 0], radius: 25 }) });
const lid = extrude(lidSk, { distance: 2 });
const plugSk = sketch(lid.cap("end"), {
  plug_out: circle({ center: [60, 0], radius: 22.8 }),
  plug_in: circle({ center: [60, 0], radius: 21.3 }),
});
const plug = extrude(plugSk, { distance: 5, op: "join", targets: lid });

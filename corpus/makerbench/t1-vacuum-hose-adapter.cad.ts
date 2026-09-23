import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "vacuum_hose_adapter", description: "Shop-vac adapter: 32.4 ID sleeve over a 32 mm port, 10 mm taper, 35 OD spigot into the hose cuff; 2 mm walls" });

part("adapter");
// Half profile in XZ (u = radius, v = along the axis), revolved about the Z axis.
const profile = sketch(XZ, {
  port_end: line([16.2, 0], [18.2, 0]),
  sleeve_outer: line([18.2, 0], [18.2, 30]),
  taper_outer: line([18.2, 30], [17.5, 40]),
  spigot_outer: line([17.5, 40], [17.5, 70]),
  hose_end: line([17.5, 70], [15.5, 70]),
  spigot_inner: line([15.5, 70], [15.5, 40]),
  taper_inner: line([15.5, 40], [16.2, 30]),
  sleeve_inner: line([16.2, 30], [16.2, 0]),
});
const adapter = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

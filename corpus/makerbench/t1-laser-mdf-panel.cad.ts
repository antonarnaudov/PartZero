import { doc, part, sketch, line, arc, circle, extrude, XY } from "@aicad/std";

doc({ name: "mdf_side_panel", description: "Laser-cut 3 mm MDF side panel 120x80: 2 tab slots, 4x M3, 12 mm switch, 8 mm DC jack, 12x11 USB-B cut-out" });

part("panel");
const panel = sketch(XY, {
  bottom: line([0, 0], [120, 0]),
  right: line([120, 0], [120, 80]),
  top: line([120, 80], [0, 80]),
  left: line([0, 80], [0, 0]),
  // Tab slots for the bottom panel: 15 x 3.2, centres 6 mm up, 30 mm either side of the middle.
  slot_l_bottom: line([22.5, 4.4], [37.5, 4.4]),
  slot_l_right: line([37.5, 4.4], [37.5, 7.6]),
  slot_l_top: line([37.5, 7.6], [22.5, 7.6]),
  slot_l_left: line([22.5, 7.6], [22.5, 4.4]),
  slot_r_bottom: line([82.5, 4.4], [97.5, 4.4]),
  slot_r_right: line([97.5, 4.4], [97.5, 7.6]),
  slot_r_top: line([97.5, 7.6], [82.5, 7.6]),
  slot_r_left: line([82.5, 7.6], [82.5, 4.4]),
  m3_bl: circle({ center: [5, 5], radius: 1.7 }),
  m3_br: circle({ center: [115, 5], radius: 1.7 }),
  m3_tr: circle({ center: [115, 75], radius: 1.7 }),
  m3_tl: circle({ center: [5, 75], radius: 1.7 }),
  // Toggle switch, 12 mm: two semicircles, the way it comes out of a DXF export.
  switch_top: arc({ start: [66, 45], end: [54, 45], center: [60, 45], ccw: true }),
  switch_bottom: arc({ start: [54, 45], end: [66, 45], center: [60, 45], ccw: true }),
  dc_jack: circle({ center: [30, 45], radius: 4 }),
  usb_bottom: line([84, 39.5], [96, 39.5]),
  usb_right: line([96, 39.5], [96, 50.5]),
  usb_top: line([96, 50.5], [84, 50.5]),
  usb_left: line([84, 50.5], [84, 39.5]),
});
const side_panel = extrude(panel, { distance: 3 });

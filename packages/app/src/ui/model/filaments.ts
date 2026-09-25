/**
 * Body colours as filament colours: Bambu Lab PLA Basic, the owner's AMS filament line, with the
 * hex codes Bambu Lab publishes for it ("Bambu Lab Filament Hex Code Table — PLA Basic",
 * store.bblcdn.com, retrieved 2026-09-25). A body coloured with one of these reads as that spool in
 * the viewport; a custom colour is any `#rrggbb`.
 */
export interface Filament {
  name: string;
  hex: string;
}

export const PLA_BASIC: readonly Filament[] = [
  { name: "Jade White", hex: "#ffffff" },
  { name: "Beige", hex: "#f7e6de" },
  { name: "Light Gray", hex: "#d1d3d5" },
  { name: "Silver", hex: "#a6a9aa" },
  { name: "Gray", hex: "#8e9089" },
  { name: "Dark Gray", hex: "#545454" },
  { name: "Blue Grey", hex: "#5b6579" },
  { name: "Black", hex: "#000000" },
  { name: "Magenta", hex: "#ec008c" },
  { name: "Pink", hex: "#f55a74" },
  { name: "Hot Pink", hex: "#f5547c" },
  { name: "Red", hex: "#c12e1f" },
  { name: "Maroon Red", hex: "#9d2235" },
  { name: "Orange", hex: "#ff6a13" },
  { name: "Pumpkin Orange", hex: "#ff9016" },
  { name: "Gold", hex: "#e4bd68" },
  { name: "Sunflower Yellow", hex: "#fec600" },
  { name: "Yellow", hex: "#f4ee2a" },
  { name: "Bright Green", hex: "#becf00" },
  { name: "Bambu Green", hex: "#00ae42" },
  { name: "Mistletoe Green", hex: "#3f8e43" },
  { name: "Bronze", hex: "#847d48" },
  { name: "Cocoa Brown", hex: "#6f5034" },
  { name: "Brown", hex: "#9d432c" },
  { name: "Turquoise", hex: "#00b1b7" },
  { name: "Cyan", hex: "#0086d6" },
  { name: "Cobalt Blue", hex: "#0056b8" },
  { name: "Blue", hex: "#0a2989" },
  { name: "Purple", hex: "#5e43b7" },
  { name: "Indigo Purple", hex: "#482960" },
];

/** The filament a colour is, if it is one of the palette's. */
export function filamentOf(hex: string | null | undefined): Filament | null {
  if (!hex) return null;
  const h = hex.toLowerCase();
  return PLA_BASIC.find((f) => f.hex === h) ?? null;
}

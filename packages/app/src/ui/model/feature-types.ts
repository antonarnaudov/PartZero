/** The icon (a `ToolIcon` name) and title of each IR v1 feature type, for the model panels. */

export const TYPE_ICON: Readonly<Record<string, string>> = {
  sketch: "sketch",
  extrude: "extrude",
  revolve: "revolve",
  hole: "hole",
  fillet: "fillet",
  chamfer: "chamfer",
  shell: "shell",
  draft: "draft",
  boolean: "combine",
  pattern: "linearPattern",
  datum_plane: "plane",
  datum_axis: "axis",
  tag: "properties",
};

export const TYPE_TITLE: Readonly<Record<string, string>> = {
  sketch: "Sketch",
  extrude: "Extrude",
  revolve: "Revolve",
  hole: "Hole",
  fillet: "Fillet",
  chamfer: "Chamfer",
  shell: "Shell",
  draft: "Draft",
  boolean: "Combine",
  pattern: "Pattern",
  datum_plane: "Construction plane",
  datum_axis: "Construction axis",
  tag: "Named selection",
};

/** A pattern's icon follows its layout (linear, circular, mirror). */
export function featureIcon(type: string, json?: unknown): string {
  if (type === "pattern" && json && typeof json === "object") {
    const layout = (json as { layout?: Record<string, unknown> }).layout;
    if (layout && "circular" in layout) return "circularPattern";
    if (layout && "mirror" in layout) return "mirror";
  }
  return TYPE_ICON[type] ?? type;
}

export const typeTitle = (type: string): string => TYPE_TITLE[type] ?? type;

/** Construction features (datums) sit in the browser's Construction folder. */
export const isConstruction = (type: string): boolean => type === "datum_plane" || type === "datum_axis";

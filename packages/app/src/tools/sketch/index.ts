/**
 * The sketch tool registry: ids, labels, groups, keys (plan §2.5 "Default keys", sketch
 * context) and factories.
 */
import { DimensionTool } from "./dimension";
import { ArcCenterTool, ArcTangentTool, LineTool, PolygonTool, arc3Tool, circle2Tool, circle3Tool, circleCenterTool, pointTool, rect2Tool, rectCenterTool, slotTool } from "./draw";
import { CornerTool, MirrorTool, OffsetTool, extendTool, trimTool } from "./modify";
import { SelectTool } from "./select";
import type { SketchTool, ToolId } from "./types";

export type { SketchTool, ToolId } from "./types";

export interface ToolInfo {
  id: ToolId;
  label: string;
  group: "select" | "draw" | "modify" | "dimension";
  /** Single-key shortcut in sketch mode. */
  key?: string;
  /** Short glyph for the palette. */
  glyph: string;
}

export const SKETCH_TOOLS: readonly ToolInfo[] = [
  { id: "select", label: "Select", group: "select", glyph: "↖" },
  { id: "line", label: "Line", group: "draw", key: "l", glyph: "╱" },
  { id: "rect2", label: "Rectangle", group: "draw", key: "r", glyph: "▭" },
  { id: "rectCenter", label: "Center rectangle", group: "draw", glyph: "⊡" },
  { id: "circleCenter", label: "Circle", group: "draw", key: "c", glyph: "◯" },
  { id: "circle2", label: "2-point circle", group: "draw", glyph: "⌀" },
  { id: "circle3", label: "3-point circle", group: "draw", glyph: "⊚" },
  { id: "arc3", label: "3-point arc", group: "draw", key: "a", glyph: "⌒" },
  { id: "arcTangent", label: "Tangent arc", group: "draw", glyph: "↻" },
  { id: "arcCenter", label: "Center arc", group: "draw", glyph: "◜" },
  { id: "slot", label: "Slot", group: "draw", glyph: "⊂⊃" },
  { id: "polygon", label: "Polygon", group: "draw", glyph: "⬡" },
  { id: "point", label: "Point", group: "draw", key: "p", glyph: "·" },
  { id: "dimension", label: "Dimension", group: "dimension", key: "d", glyph: "↔" },
  { id: "trim", label: "Trim", group: "modify", key: "t", glyph: "✂" },
  { id: "extend", label: "Extend", group: "modify", key: "e", glyph: "⇥" },
  { id: "offset", label: "Offset", group: "modify", key: "o", glyph: "⧉" },
  { id: "mirror", label: "Mirror", group: "modify", key: "m", glyph: "⇋" },
  { id: "fillet", label: "Sketch fillet", group: "modify", glyph: "◟" },
  { id: "chamfer", label: "Sketch chamfer", group: "modify", glyph: "◺" },
];

export function createTool(id: ToolId): SketchTool {
  switch (id) {
    case "select":
      return new SelectTool();
    case "line":
      return new LineTool();
    case "rect2":
      return rect2Tool();
    case "rectCenter":
      return rectCenterTool();
    case "circleCenter":
      return circleCenterTool();
    case "circle2":
      return circle2Tool();
    case "circle3":
      return circle3Tool();
    case "arc3":
      return arc3Tool();
    case "arcTangent":
      return new ArcTangentTool();
    case "arcCenter":
      return new ArcCenterTool();
    case "slot":
      return slotTool();
    case "polygon":
      return new PolygonTool();
    case "point":
      return pointTool();
    case "dimension":
      return new DimensionTool();
    case "trim":
      return trimTool();
    case "extend":
      return extendTool();
    case "offset":
      return new OffsetTool();
    case "mirror":
      return new MirrorTool();
    case "fillet":
      return new CornerTool("fillet");
    case "chamfer":
      return new CornerTool("chamfer");
  }
}

export function toolInfo(id: ToolId): ToolInfo {
  return SKETCH_TOOLS.find((t) => t.id === id)!;
}

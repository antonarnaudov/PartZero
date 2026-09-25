/**
 * The ribbon's Sketch tool: opens sketch mode (the plane picker, then the sketcher over the
 * viewport). It has no property panel: sketch mode is its own UI (`ui/sketch/SketchModeHost.tsx`),
 * driven by the same `sketchMode` as the `sketch.*` commands and the sketcher's test hooks. It
 * replaces the old toolbar's Sketch button, so `tool.start { id: "sketch.new" }` is how the palette,
 * the keyboard (⇧S) and an agent open a sketch.
 */
import { sketchMode } from "../../sketch/instance";
import type { ToolDefinition } from "../framework/types";
import type { ToolRegistry } from "../registry";

export const SKETCH_TOOL_ID = "sketch.new";

export const sketchTool: ToolDefinition = {
  id: SKETCH_TOOL_ID,
  label: "Sketch",
  group: "sketch",
  icon: "sketch",
  shortcut: "Shift+S",
  description: "New sketch on the XY, XZ or YZ plane, or on a selected planar face",
  order: 10,
  enabledWhen: () => (sketchMode.getState().phase === "active" ? { reason: "A sketch is open: finish or cancel it first." } : true),
  activate() {
    sketchMode.requestNew();
  },
};

export function registerSketchTools(registry: ToolRegistry): void {
  registry.register(sketchTool);
}

/**
 * Registration point for toolbar tools (plan §3.3: "Toolbar tabs built from tools/registry.ts — one
 * tool entry"). Each workstream adds **one line** here for its tool module: a function that
 * registers its tools, e.g. `registerFeatureTools` (FEAT) or `registerSketchTools` (SKUI).
 */
import { registerFeatureTools } from "./builtin/features";
import { registerInspectTools } from "./builtin/inspect";
import { registerSketchTools } from "./builtin/sketch";
import type { ToolRegistry } from "./registry";

export const TOOL_MODULES: ReadonlyArray<(registry: ToolRegistry) => void> = [
  registerSketchTools,
  registerFeatureTools,
  registerInspectTools,
];

export function registerAllTools(registry: ToolRegistry): void {
  for (const register of TOOL_MODULES) register(registry);
}

/**
 * The create and construct tools (FEAT): Extrude, Revolve, Hole, Push/Pull, Combine, Plane and
 * Axis — each a panel over the model-ops command of the same name, which the agent and MCP call too.
 */
import type { ToolRegistry } from "../registry";
import { combineTool } from "./combine";
import { datumAxisTool, datumPlaneTool } from "./datum";
import { extrudeTool } from "./extrude";
import { holeTool } from "./hole";
import { moveTool } from "./move";
import { pushPullTool } from "./push-pull";
import { revolveTool } from "./revolve";

export const CREATE_TOOLS = [extrudeTool, revolveTool, holeTool, pushPullTool, moveTool, combineTool, datumPlaneTool, datumAxisTool] as const;

export function registerCreateTools(registry: ToolRegistry): void {
  for (const t of CREATE_TOOLS) registry.register(t);
}

export { combineTool, datumAxisTool, datumPlaneTool, extrudeTool, holeTool, moveTool, pushPullTool, revolveTool };

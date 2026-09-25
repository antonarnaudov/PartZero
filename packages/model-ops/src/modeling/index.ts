/**
 * The modeling tools as commands (see `tool.ts`): one definition per hand tool, called by the app's
 * panels and `model.*` commands, the agent's tools and MCP alike.
 */
import type { OpsCommit, OpsHost } from "../host.js";
import { booleanModelingTool } from "./boolean.js";
import { datumAxisModelingTool, datumPlaneModelingTool } from "./datum.js";
import { extrudeModelingTool } from "./extrude.js";
import { holeModelingTool } from "./hole.js";
import { pushPullModelingTool } from "./push-pull.js";
import { revolveModelingTool } from "./revolve.js";
import type { ModelingContext, ModelingPlan, ModelingTool } from "./tool.js";

export * from "./boolean.js";
export * from "./datum.js";
export * from "./extrude.js";
export * from "./frames.js";
export * from "./hole.js";
export * from "./keys.js";
export * from "./probe.js";
export * from "./push-pull.js";
export * from "./revolve.js";
export * from "./tool.js";

/** Every modeling tool, in toolbar order. */
export const MODELING_TOOLS: readonly ModelingTool<any>[] = [
  extrudeModelingTool,
  revolveModelingTool,
  holeModelingTool,
  booleanModelingTool,
  pushPullModelingTool,
  datumPlaneModelingTool,
  datumAxisModelingTool,
];

export function modelingTool(id: string): ModelingTool<any> | undefined {
  return MODELING_TOOLS.find((t) => t.id === id || t.agentTool === id);
}

/** The context a modeling tool builds against, from an ops host (the app's live document, or a headless one). */
export async function modelingContextOf(host: OpsHost): Promise<ModelingContext> {
  const [document, hostState] = await Promise.all([host.document(), host.hostState()]);
  let report: ModelingContext["report"] = null;
  try {
    report = (await host.report()) as unknown as ModelingContext["report"];
  } catch {
    report = null;
  }
  return { document, host: hostState, report, engine: host.engine() };
}

/**
 * Run a modeling tool on an ops host: parse the arguments, build the ops against the host's current
 * document, apply them as ONE transaction (the host's origin: an agent's features are marked).
 */
export async function runModelingTool(tool: ModelingTool<any>, rawArgs: unknown, host: OpsHost, options: { ack?: readonly string[] } = {}): Promise<{ plan: ModelingPlan; commit: OpsCommit }> {
  const args = tool.args.parse(rawArgs) as Record<string, unknown>;
  const ctx = await modelingContextOf(host);
  const plan = await tool.build(args, ctx);
  const commit = await host.apply(plan.ops, { label: plan.label, ...(options.ack ? { ack: options.ack } : {}) });
  return { plan, commit };
}

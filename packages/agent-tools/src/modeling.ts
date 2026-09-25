/**
 * The modeling tools as agent tools (the owner's rule: the AI operates the same hand tools the user
 * does, and chains them): Extrude, Revolve, Hole, Combine, Push/Pull, Datum Plane and Datum Axis,
 * **generated from** `@aicad/model-ops`'s `MODELING_TOOLS` — the definitions the app's panels and
 * `model.*` commands run. Each call builds the tool's ops against the host's current document and
 * applies them as ONE transaction (the agent's features are marked; the user's need approval).
 * Edit an existing feature by passing `feature` with the arguments to change.
 */
import { CommandEngineError, MODELING_TOOLS, modelingContextOf, type ModelingTool } from "@aicad/model-ops";
import { z } from "zod";
import { clip } from "./format.js";
import { defineTool, type AgentTool, type ToolOutput } from "./registry.js";
import type { OpsToolContext } from "./ops.js";

const Ack = z
  .array(z.string().min(1).max(200))
  .max(1000)
  .optional()
  .describe("The ids of your own newly failing features to accept, exactly as a COMMAND_NEW_FAILURES refusal listed them.");

function refusal(e: unknown, tool: string): ToolOutput {
  if (e instanceof CommandEngineError) {
    const details = Object.keys(e.details).length ? ` details: ${clip(JSON.stringify(e.details), 1200)}` : "";
    const errors = e.errors.length ? ` problems: ${clip(JSON.stringify(e.errors.slice(0, 5)), 1200)}` : "";
    return { text: `Refused (${e.code}): ${e.message}.${errors}${details} Nothing was changed.`, isError: true, data: { kind: "ops_refused", code: e.code, tool } };
  }
  if (e instanceof z.ZodError) {
    const issues = e.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
    return { text: `Invalid ${tool} arguments: ${issues.join("; ")}. Nothing was changed.`, isError: true, data: { kind: "invalid_input" } };
  }
  return { text: `Refused: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`, isError: true, data: { kind: "ops_refused", code: "FAILED", tool } };
}

/** One modeling tool as an agent tool: its own arguments plus `ack`. */
export function modelingAgentTool(tool: ModelingTool<any>): AgentTool<OpsToolContext, z.ZodObject> {
  const input = (tool.args as unknown as z.ZodObject<z.ZodRawShape>).extend({ ack: Ack });
  return defineTool<OpsToolContext, z.ZodObject>({
    name: tool.agentTool,
    description: tool.description,
    input,
    async run(raw, ctx) {
      if (ctx.readOnly) return { text: `${tool.agentTool} changes the model; this is a read-only session.`, isError: true, data: { kind: "read_only" } };
      const { ack, ...rest } = raw as { ack?: string[] } & Record<string, unknown>;
      const args = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null));
      try {
        const parsed = tool.args.parse(args);
        const mctx = await modelingContextOf(ctx.ops);
        const plan = await tool.build(parsed, mctx);
        if (plan.ops.length === 0) return { text: `No change: ${plan.label} already is that way.`, data: { kind: "ops_commit", changed: false } };
        const c = await ctx.ops.apply(plan.ops, { label: plan.label, ...(ack ? { ack } : {}) });
        const ops = plan.ops.map((o) => `${o.op}: ${clip(JSON.stringify(o), 500)}`).join("\n");
        const fails = c.newFailures?.length ? `\nAcknowledged newly failing: ${c.newFailures.map((f) => `${f.name} (${f.code})`).join(", ")}.` : "";
        return {
          text: `Done: ${plan.label} (revision ${c.revision})${plan.feature ? `, feature ${plan.feature}` : ""}.\n${ops}${fails}`,
          data: { kind: "ops_commit", tool: tool.agentTool, feature: plan.feature, changed: c.changed, revision: c.revision, ops: plan.ops.map((o) => o.op) },
        };
      } catch (e) {
        return refusal(e, tool.agentTool);
      }
    },
  });
}

/** Every modeling tool as an agent tool. */
export function modelingAgentTools(): AgentTool<OpsToolContext, z.ZodObject>[] {
  return MODELING_TOOLS.map(modelingAgentTool);
}

/** The agent tool names of the modeling tools. */
export const MODELING_AGENT_TOOLS: readonly string[] = MODELING_TOOLS.map((t) => t.agentTool);

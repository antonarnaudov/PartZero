/**
 * The modeling tools as app commands (`model.extrude`, `model.hole`, …), generated from
 * `@aicad/model-ops`'s `MODELING_TOOLS`: the same definition the toolbar's panels, the agent's tools
 * and MCP run. A command builds the tool's ops against the document as it is and commits them as
 * ONE transaction through `runOps` (the failure rule; a user gesture is asked "Apply anyway?"; an
 * agent caller's features are marked and it may not change yours). The palette, the native menu,
 * `window.__aicad.execute` and automation reach them like any other command.
 */
import {
  booleanModelingTool,
  datumAxisModelingTool,
  datumPlaneModelingTool,
  extrudeModelingTool,
  holeModelingTool,
  pushPullModelingTool,
  revolveModelingTool,
  type ModelingTool,
} from "@aicad/model-ops";
import { z } from "zod";
import type { AppServices } from "../services";
import { appModelingContext } from "../tools/create/kit";
import { runOps, type IrTransactionResult } from "./ir-commands";
import { defineCommand, type CommandSpec } from "./registry";

const command = defineCommand<AppServices>();
const Ack = z.array(z.string().min(1).max(200)).max(1000).optional();
const enabled = (ctx: AppServices): boolean => ctx.ir !== undefined && ctx.ir.getState().document !== null;

export type ModelCommandResult = (IrTransactionResult & { feature: string | null }) | { changed: false; label: string; feature: string | null };

type ModelArgs<A> = A & { ack?: string[] | undefined };

function modelCommand<A extends Record<string, unknown>, Id extends string>(id: Id, tool: ModelingTool<A>): CommandSpec<z.ZodType<ModelArgs<A>, ModelArgs<A>>, Promise<ModelCommandResult>, AppServices> & { id: Id } {
  const args = (tool.args as unknown as z.ZodObject<z.ZodRawShape>).extend({ ack: Ack }) as unknown as z.ZodType<ModelArgs<A>, ModelArgs<A>>;
  return command({
    id,
    title: tool.title,
    category: "Model",
    description: `${tool.description} (The ${tool.title} tool's command: the toolbar panel, the agent's \`${tool.agentTool}\` tool and MCP run the same one.)`,
    args,
    palette: false,
    enabled,
    async run(raw, ctx, meta): Promise<ModelCommandResult> {
      const { ack, ...rest } = raw as ModelArgs<A>;
      const plan = await tool.build(rest as unknown as A, await appModelingContext(ctx));
      if (plan.ops.length === 0) return { changed: false, label: plan.label, feature: plan.feature };
      const r = await runOps(ctx, meta, plan.ops, { label: plan.label, ...(ack ? { ack } : {}) });
      return { ...r, feature: plan.feature };
    },
  }) as CommandSpec<z.ZodType<ModelArgs<A>, ModelArgs<A>>, Promise<ModelCommandResult>, AppServices> & { id: Id };
}

export const MODEL_COMMANDS = {
  "model.extrude": modelCommand("model.extrude", extrudeModelingTool),
  "model.revolve": modelCommand("model.revolve", revolveModelingTool),
  "model.hole": modelCommand("model.hole", holeModelingTool),
  "model.combine": modelCommand("model.combine", booleanModelingTool),
  "model.pushPull": modelCommand("model.pushPull", pushPullModelingTool),
  "model.datumPlane": modelCommand("model.datumPlane", datumPlaneModelingTool),
  "model.datumAxis": modelCommand("model.datumAxis", datumAxisModelingTool),
};

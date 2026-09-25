/**
 * The app's live document as an {@link OpsHost} (`@aicad/model-ops`): what the agent's op tools
 * (`@aicad/agent-tools` `opTools()`) and the MCP `ops` / `ext-ops` scopes run against when they
 * operate the open model. Every op goes through the app's command registry (`ir.apply`, with the
 * caller's source: `agent` or `mcp`), so it is exactly what the user's tools do — one undoable
 * transaction each, visible at once in the viewport and the timeline, authored `agent` (ADR 0015),
 * refused by the same checks. The store gives the caller the parameters it added itself, as
 * `MemoryOpsHost` does (`OwnParams`), so the same op script behaves the same in both hosts.
 */
import { CommandEngineError, type HostState, type IrCommandEngine, type IrOp, type OpsApplyOptions, type OpsCommit, type OpsHost } from "@aicad/model-ops";
import type { metricsV1 } from "@aicad/ir-types";
import type { AppCommandRegistry } from "../commands/commands";
import type { IrTransactionResult } from "../commands/ir-commands";
import type { AppServices } from "../services";

function store(services: AppServices) {
  if (!services.ir) throw new CommandEngineError("IR_UNAVAILABLE", "this host has no IR v1 document store");
  return services.ir;
}

export function appOpsHost(services: AppServices, commands: AppCommandRegistry, source: "agent" | "mcp" = "agent"): OpsHost {
  return {
    async document(): Promise<string> {
      await services.doc.idle();
      return store(services).document;
    },
    async hostState(): Promise<HostState> {
      await services.doc.idle();
      return store(services).getState().host;
    },
    async apply(ops: readonly IrOp[], options: OpsApplyOptions = {}): Promise<OpsCommit> {
      const r = await commands.execute(
        {
          id: "ir.apply",
          args: {
            ops: [...ops],
            ...(options.label ? { label: options.label } : {}),
            ...(options.ack ? { ack: [...options.ack] } : {}),
            ...(options.group !== undefined ? { group: options.group } : {}),
          },
        },
        { source },
      );
      if (!r.ok) {
        const d = r.error.detail;
        throw new CommandEngineError(d?.code ?? r.error.code, r.error.message, (d?.errors as never) ?? [], d?.details ?? {});
      }
      await services.doc.idle();
      const v = r.value as IrTransactionResult;
      return { changed: v.changed, label: v.label, revision: v.revision, ops: v.ops, ...(v.newFailures ? { newFailures: v.newFailures } : {}) };
    },
    report(): Promise<metricsV1.EvalReport> {
      return store(services).report();
    },
    engine(): IrCommandEngine {
      return store(services).commandEngine();
    },
  };
}

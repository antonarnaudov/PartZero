/**
 * The shell's {@link OpsPort} on an IR v1 document: a tool's ops go through the command layer as
 * ONE transaction (`ir.apply`, with the tool's label), exactly as the agent's and MCP's do. The
 * command's source is the gesture's (`ui`, `keyboard`, `palette`), so the transaction is the user's,
 * and a change that makes features newly fail asks "Apply anyway?" before it lands.
 *
 * On a CadScript (IR v0) document (hosts without the IR v1 engine) it hands the ops to the v0 port.
 */
import type { AppInvocation } from "../../commands/commands";
import type { CommandResult, CommandSource } from "../../commands/registry";
import type { AppServices } from "../../services";
import type { CommitOutcome, FieldError, OpsPort } from "./types";
import { v0OpsPort } from "./v0-ops";

type Run = (cmd: AppInvocation, source: CommandSource) => Promise<CommandResult<unknown>>;

/** The field a refusal's JSON pointer names (`/parts/0/features/3/distance` → `distance`), for the panel. */
function fieldOf(detail: { errors?: unknown[] } | undefined): string | undefined {
  const first = detail?.errors?.[0] as { path?: unknown } | undefined;
  const m = typeof first?.path === "string" ? /^\/parts\/\d+\/features\/\d+\/([^/]+)/.exec(first.path) : null;
  return m?.[1];
}

export function appOpsPort(services: AppServices, run: Run): OpsPort {
  const v0 = v0OpsPort(services, run);
  return {
    async apply(ops, meta): Promise<CommitOutcome> {
      if (ops.length === 0) return { ok: true };
      if (!services.doc.isV1) return v0.apply(ops, meta);
      await services.doc.idle();
      const r = await run({ id: "ir.apply", args: { ops: [...ops], label: meta.label.slice(0, 200) } }, meta.source);
      if (r.ok) return { ok: true };
      const d = r.error.detail;
      const field = fieldOf(d);
      const error: FieldError = { ...(d?.code ? { code: d.code } : {}), message: r.error.message, ...(field ? { field } : {}) };
      return { ok: false, errors: [error] };
    },
  };
}

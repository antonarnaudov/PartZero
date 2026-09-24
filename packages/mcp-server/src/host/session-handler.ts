/**
 * The in-process host API: bind a `DesignSession` and the agent-tools registry to a broker handler.
 *
 * `sessionToolHandler()` turns every broker call into `ToolRegistry.execute()` on the host's session
 * (zod validation, the verification ladder, repair hints, errors as results) and closes the broker
 * when a finishing tool succeeds (`propose` → "proposed", `submit_spec` → "spec_submitted").
 *
 * The in-app agent binds its broker to `AgentRun`'s own `#execute` instead (CLI-PROVIDERS.md §3.3), so
 * orchestrator notes, stop rules and the PROPOSE gate apply; this handler is the plain binding for
 * hosts without an orchestrator (external clients, tests, the fake CLI).
 */
import { evalModeAnswers, type DesignSession, type DesignToolContext, type ToolData, type ToolOutput, type ToolRegistry, type UserQuestion } from "@aicad/agent-tools";
import type { McpCallControl, McpToolCall, McpToolResult } from "../types.js";

/** Close reasons for tools that end a phase when they succeed. */
export const DEFAULT_CLOSE_ON: Readonly<Record<string, string>> = Object.freeze({ propose: "proposed", submit_spec: "spec_submitted" });

export interface SessionHandlerOptions {
  session: DesignSession;
  /** The scope's tools (`registry.subset(scopeToolNames(scope))`). */
  registry: ToolRegistry<DesignToolContext>;
  /** Answers `ask_user`. Default: "the user is not available: use your default" (eval mode). */
  askUser?: (questions: readonly UserQuestion[]) => Promise<string[]> | string[];
  /** Question mode: tools that change the design refuse. */
  readOnly?: boolean;
  /** Tool → close reason, applied when that tool succeeds. Default {@link DEFAULT_CLOSE_ON}. */
  closeOn?: Readonly<Record<string, string>>;
  /** Every executed call with its structured data (the proposal, the spec, apply outcomes…). */
  onResult?(call: McpToolCall, output: ToolOutput & { data?: ToolData }): void;
}

/**
 * The handler. The user's answer to `ask_user` goes through `control.userWait()` (when the broker passes
 * it), so the broker's handler deadline excludes the wait; the wait is also reported as `userWaitMs`.
 */
export function sessionToolHandler(options: SessionHandlerOptions): (call: McpToolCall, control?: McpCallControl) => Promise<McpToolResult> {
  const closeOn = options.closeOn ?? DEFAULT_CLOSE_ON;
  const answer = options.askUser ?? evalModeAnswers();
  return async (call, control) => {
    let userWaitMs = 0;
    const ctx: DesignToolContext = {
      session: options.session,
      askUser: async (qs) => {
        const t0 = Date.now();
        try {
          const wait = Promise.resolve(answer(qs));
          return await (control ? control.userWait(wait) : wait);
        } finally {
          userWaitMs += Date.now() - t0;
        }
      },
      ...(options.readOnly ? { readOnly: true } : {}),
    };
    const out = await options.registry.execute({ ...(call.toolUseId ? { id: call.toolUseId } : {}), name: call.name, input: call.args }, ctx);
    options.onResult?.(call, out);
    const isError = out.isError === true;
    const reason = closeOn[call.name];
    return {
      text: out.text,
      isError,
      ...(reason !== undefined && !isError ? { close: reason } : {}),
      ...(userWaitMs > 0 ? { userWaitMs } : {}),
    };
  };
}

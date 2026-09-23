/**
 * SPEC: the spec writer runs in a FRESH conversation that never contains builder messages. It sees
 * only the request, the clarification answers and (for edits) a summary of the starting model, and
 * produces a DesignSpec plus executable tests in the check DSL. Submitting freezes the tests.
 */
import { Conversation, type Message, type ToolResultBlock } from "@aicad/llm-gateway";
import { irSummary, measureText, specWriterRegistry, type DesignSession, type DesignSpec, type DesignToolContext } from "@aicad/agent-tools";
import type { PromptInfo } from "./prompts.js";
import { callModel, type RunContext } from "./run-context.js";

export interface Clarification {
  question: string;
  answer: string;
}

export interface SpecInput {
  prompt: string;
  process?: string | undefined;
  clarifications: readonly Clarification[];
}

export function processLine(process: string | undefined): string | undefined {
  const names: Record<string, string> = { fdm: "FDM 3D printing", cnc: "CNC machining", laser: "laser cutting (sheet)", any: "any" };
  if (process === undefined) return undefined;
  return `Manufacturing process: ${names[process] ?? process}.`;
}

export function clarificationsBlock(c: readonly Clarification[]): string | undefined {
  if (c.length === 0) return undefined;
  return `<clarifications>\n${c.map((x) => `- Q: ${x.question}\n  A: ${x.answer}`).join("\n")}\n</clarifications>`;
}

function specHeader(input: SpecInput, session: DesignSession): string {
  const parts = [`<request>\n${input.prompt}\n</request>`];
  const p = processLine(input.process);
  if (p) parts.push(p);
  const c = clarificationsBlock(input.clarifications);
  if (c) parts.push(c);
  if (session.context?.ir) {
    parts.push(
      `<starting_model>\nThis is an edit of an existing model. Tests may compare with it using "$context" and changed_features / changed_curves.\n${irSummary(session.context.ir, session.context.report, { maxChars: 6000 })}\n${measureText(session.context.report)}\n</starting_model>`,
    );
  }
  parts.push("Write the DesignSpec and 4–10 executable tests: call set_spec_tests (fix any problems it reports), then submit_spec.");
  return parts.join("\n\n");
}

export interface SpecOutcome {
  spec?: DesignSpec;
  messages: Message[];
  /** Why no complete spec was produced. */
  note?: string;
}

export async function runSpecWriter(rc: RunContext, prompt: PromptInfo, session: DesignSession, input: SpecInput): Promise<SpecOutcome> {
  const registry = specWriterRegistry();
  const tools = registry.defs();
  const system = [{ type: "text" as const, text: prompt.text }];
  const convo = new Conversation().appendUser(specHeader(input, session));
  const ctx: DesignToolContext = {
    session,
    askUser: (qs) => qs.map(() => "The spec writer cannot ask the user: choose a sensible default and record it as an assumption."),
  };
  let spec: DesignSpec | undefined;
  let nudged = false;
  for (let turn = 0; turn < rc.limits.maxSpecTurns && !spec; turn++) {
    const res = await callModel(rc, "spec_writer", { system, tools, messages: [...convo.messages] });
    convo.appendResponse(res);
    const calls = res.message.content.filter((b) => b.type === "tool_use");
    if (calls.length === 0) {
      if (nudged) break;
      nudged = true;
      convo.appendUser("Call set_spec_tests with the tests, then submit_spec. Do not answer in text.");
      continue;
    }
    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      if (call.type !== "tool_use") continue;
      if (spec) {
        results.push({ type: "tool_result", toolUseId: call.id, content: "Not executed: the spec is already frozen.", isError: true });
        continue;
      }
      const t0 = rc.now();
      const out = await registry.execute(
        { id: call.id, name: call.name, input: call.input, ...(call.inputError === undefined ? {} : { inputError: call.inputError, rawInput: call.rawInput ?? "" }) },
        ctx,
      );
      rc.trace.tool({ name: call.name, ok: !out.isError, ms: Math.round(rc.now() - t0), phase: "SPEC" }, out.text.split("\n")[0] ?? "");
      if (out.data?.kind === "spec") spec = out.data["spec"] as DesignSpec;
      results.push({ type: "tool_result", toolUseId: call.id, content: out.text, ...(out.isError ? { isError: true } : {}) });
    }
    convo.appendUser(results);
  }
  if (spec) return { spec, messages: [...convo.messages] };
  if (session.tests.length > 0) {
    const partial = session.freezeSpec({ summary: "(the spec writer set tests but did not submit a spec)", requirements: [], assumptions: [], key_dimensions: [] });
    return { spec: partial, messages: [...convo.messages], note: "spec not submitted; the valid tests were frozen" };
  }
  session.freezeTests();
  return { messages: [...convo.messages], note: "no valid spec tests; building without L3" };
}

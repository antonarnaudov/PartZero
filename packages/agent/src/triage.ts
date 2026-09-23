/**
 * TRIAGE: a cheap model classifies the request (ask / quick edit / design), its complexity and
 * whether a clarification round is warranted. One call with one strict tool; any failure falls
 * back to a safe default instead of failing the run.
 */
import { z } from "zod";
import { Conversation, type Message, type ToolDef } from "@aicad/llm-gateway";
import { toStrictJsonSchema } from "@aicad/agent-tools";
import type { PromptInfo } from "./prompts.js";
import { AgentStop, callModel, responseText, type RunContext } from "./run-context.js";

export type TriageKind = "ask" | "quick_edit" | "design";
export type Complexity = "T1" | "T2" | "T3";

export interface TriageResult {
  kind: TriageKind;
  complexity: Complexity;
  needs_clarification: boolean;
  reason: string;
  /** `model`: classified by the model; `fallback`: the model gave nothing usable; `forced`: set by the caller. */
  source: "model" | "fallback" | "forced";
}

export const classifySchema = z.object({
  kind: z.enum(["ask", "quick_edit", "design"]).describe("ask = question only; quick_edit = small local change to the open model; design = new part or bigger change."),
  complexity: z.enum(["T1", "T2", "T3"]).describe("T1 simple single-profile part; T2 several features/bodies; T3 assembly."),
  needs_clarification: z.boolean().describe("True only if an ambiguity changes topology/interfaces (or units are unclear, or requirements conflict) and no safe default exists."),
  reason: z.string().describe("One short sentence."),
});

export const CLASSIFY_TOOL: ToolDef = {
  name: "classify",
  description: "Record how this request should be handled. Call exactly once.",
  inputSchema: toStrictJsonSchema(classifySchema),
  strict: true,
};

export function fallbackTriage(hasModel: boolean, reason: string): TriageResult {
  return { kind: hasModel ? "quick_edit" : "design", complexity: "T1", needs_clarification: false, reason, source: "fallback" };
}

export interface TriageInput {
  prompt: string;
  /** One line about the open model, when there is one. */
  openModel?: string;
}

export async function runTriage(rc: RunContext, prompt: PromptInfo, input: TriageInput): Promise<{ result: TriageResult; messages: Message[] }> {
  const convo = new Conversation().appendUser(`<request>\n${input.prompt}\n</request>\nOpen model: ${input.openModel ?? "none (nothing is open)"}`);
  let res;
  try {
    res = await callModel(rc, "triage", { system: [{ type: "text", text: prompt.text }], tools: [CLASSIFY_TOOL], messages: [...convo.messages] });
  } catch (e) {
    // Triage is advisory: only budget and refusals end the run.
    if (e instanceof AgentStop && e.reason !== "budget" && e.reason !== "refusal") {
      return { result: fallbackTriage(input.openModel !== undefined, `triage failed: ${e.message}`), messages: [...convo.messages] };
    }
    throw e;
  }
  convo.appendResponse(res);
  const call = res.message.content.find((b) => b.type === "tool_use" && b.name === "classify");
  if (call && call.type === "tool_use" && call.inputError === undefined) {
    const parsed = classifySchema.safeParse(call.input);
    if (parsed.success) return { result: { ...parsed.data, source: "model" }, messages: [...convo.messages] };
  }
  // Tolerate a model that answered in text.
  const text = responseText(res);
  const kind = (["quick_edit", "design", "ask"] as const).find((k) => new RegExp(`\\b${k}\\b`).test(text));
  if (kind) {
    return {
      result: { kind, complexity: /\bT2\b/.test(text) ? "T2" : /\bT3\b/.test(text) ? "T3" : "T1", needs_clarification: /needs_clarification"?\s*[:=]\s*true/.test(text), reason: "parsed from text", source: "model" },
      messages: [...convo.messages],
    };
  }
  return { result: fallbackTriage(input.openModel !== undefined, "no classification returned"), messages: [...convo.messages] };
}

/**
 * Opt-in live smoke tests: one tiny tool-use round trip per provider through the official SDKs.
 * Skipped unless the provider's key is set (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY).
 * Models can be overridden with LIVE_ANTHROPIC_MODEL / LIVE_OPENAI_MODEL / LIVE_GOOGLE_MODEL (profile ids).
 * Each round trip runs inside a task with a small USD budget, so a mapping bug cannot run up a bill.
 */
import { describe, expect, it } from "vitest";
import { Conversation } from "../../src/conversation.js";
import { LLMGateway } from "../../src/gateway.js";
import type { ToolDef } from "../../src/types.js";

const addTool: ToolDef = {
  name: "add",
  description: "Add two integers. Always use this tool for arithmetic.",
  strict: true,
  inputSchema: {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "integer" } },
    required: ["a", "b"],
    additionalProperties: false,
  },
};

async function roundTrip(model: string): Promise<void> {
  const gateway = new LLMGateway();
  const task = gateway.createTask({ id: `live-${model}`, budgetUsd: 0.25, projectionOutputTokens: 2000 });
  const convo = new Conversation().appendUser("Use the add tool to compute 1234 + 4321, then reply with just the number.");
  const base = { model, tools: [addTool], maxOutputTokens: 2000, reasoning: { effort: "low" as const } };

  const first = await task.chat({ ...base, messages: [...convo.messages] });
  expect(first.stopReason).toBe("tool_use");
  convo.appendResponse(first);
  const calls = convo.pendingToolCalls();
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.name).toBe("add");
  const sum = Number(call.input["a"]) + Number(call.input["b"]);
  convo.appendUser([{ type: "tool_result", toolUseId: call.id, content: String(sum) }]);

  const second = await task.chat({ ...base, messages: [...convo.messages] });
  expect(second.stopReason).toBe("end_turn");
  const text = second.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  expect(text).toContain("5555");
  expect(task.costUsd).toBeGreaterThan(0);
}

const env = process.env;

describe.skipIf(!env["ANTHROPIC_API_KEY"])("live: Anthropic", () => {
  it("tool-use round trip", { timeout: 120_000 }, () => roundTrip(env["LIVE_ANTHROPIC_MODEL"] ?? "claude-haiku-4-5"));
});

describe.skipIf(!env["OPENAI_API_KEY"])("live: OpenAI", () => {
  it("tool-use round trip", { timeout: 120_000 }, () => roundTrip(env["LIVE_OPENAI_MODEL"] ?? "gpt-6-luna"));
});

describe.skipIf(!env["GEMINI_API_KEY"])("live: Google Gemini", () => {
  it("tool-use round trip", { timeout: 120_000 }, () => roundTrip(env["LIVE_GOOGLE_MODEL"] ?? "gemini-3.5-flash-lite"));
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterContext } from "../src/adapters/adapter.js";
import { BUILTIN_PROFILES } from "../src/builtin-profiles.js";
import { resolveMaxOutputTokens } from "../src/pricing.js";
import { ProfileRegistry, type ModelProfile } from "../src/profile.js";
import type { Fixture } from "../src/transport/transport.js";
import type { ChatRequest, ChatResponse, StreamEvent, ToolDef } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXED_NOW = new Date("2026-09-23T12:00:00Z");

export function loadFixture(relative: string): Fixture {
  return JSON.parse(readFileSync(join(here, "fixtures", relative), "utf8")) as Fixture;
}

export const registry = new ProfileRegistry(BUILTIN_PROFILES);

export function profile(id: string): ModelProfile {
  return registry.get(id);
}

export function ctxFor(request: ChatRequest, p: ModelProfile = profile(request.model)): AdapterContext {
  return { profile: p, request, maxOutputTokens: resolveMaxOutputTokens(request, p), now: FIXED_NOW };
}

/** 1x1 transparent PNG. */
export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** A CAD-ish tool with an optional field and constraints that strict modes do not all support. */
export const renderTool: ToolDef = {
  name: "render_views",
  description: "Render the current part from named views. Call this before judging geometry visually.",
  strict: true,
  inputSchema: {
    type: "object",
    properties: {
      views: { type: "array", items: { type: "string", enum: ["iso", "top", "front", "right"] }, minItems: 1 },
      highlight: { type: "string", description: "Entity id to highlight", pattern: "^(face|edge):\\d+$" },
      scale: { type: "number", minimum: 0.1, maximum: 10 },
    },
    required: ["views"],
  },
};

export const measureTool: ToolDef = {
  name: "measure",
  description: "Measure an entity (face, edge) by id.",
  inputSchema: {
    type: "object",
    properties: { entity: { type: "string" } },
    required: ["entity"],
  },
};

/** A two-step conversation: user asks with an image; the gateway is expected to call render_views. */
export function firstTurn(model: string, extra: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model,
    system: [
      { type: "text", text: "You are the aicad designer agent. Use tools; never guess geometry." },
      { type: "text", text: "CadScript reference: box(w, d, h), fillet(edges, r), hole(face, d)." },
    ],
    tools: [renderTool, measureTool],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Is the bracket wall thick enough for PLA?" },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_1PX } },
        ],
      },
    ],
    ...extra,
  };
}

export async function collect(gen: AsyncGenerator<StreamEvent, ChatResponse>): Promise<{ events: StreamEvent[]; response: ChatResponse }> {
  const events: StreamEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done === true) return { events, response: r.value };
    events.push(r.value);
  }
}

export async function* iterate<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield structuredClone(item);
}

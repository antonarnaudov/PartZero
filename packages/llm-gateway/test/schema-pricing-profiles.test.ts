import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES } from "../src/builtin-profiles.js";
import { GatewayError, normalizeProviderError } from "../src/errors.js";
import { computeCostUsd, pricesAt } from "../src/pricing.js";
import { modelProfileSchema } from "../src/profile.js";
import { stripOptionalNulls, toAnthropicSchema, toGoogleSchema, toOpenAIStrictSchema } from "../src/schema.js";
import { emptyUsage } from "../src/types.js";
import { profile } from "./helpers.js";

describe("tool schema rewriting", () => {
  const nested = {
    type: "object",
    properties: {
      feature: {
        type: "object",
        properties: { kind: { const: "fillet" }, radius: { type: "number", exclusiveMinimum: 0 }, note: { type: "string" } },
        required: ["kind", "radius"],
      },
      tags: { type: "array", items: { type: "object", properties: { k: { type: "string" }, v: { type: "string" } }, required: ["k"] } },
    },
    required: ["feature"],
  };

  it("OpenAI strict: every object closed, all properties required, optional ones nullable (recursively)", () => {
    const s = toOpenAIStrictSchema("t", nested) as any;
    expect(s.required).toEqual(["feature", "tags"]);
    expect(s.properties.tags.type).toEqual(["array", "null"]);
    expect(s.properties.feature.required).toEqual(["kind", "radius", "note"]);
    expect(s.properties.feature.properties.note.type).toEqual(["string", "null"]);
    expect(s.properties.tags.items).toMatchObject({ required: ["k", "v"], additionalProperties: false, properties: { v: { type: ["string", "null"] } } });
    expect(s.properties.feature.properties.kind).toEqual({ const: "fillet" });
  });

  it("stripOptionalNulls maps strict-mode nulls back to absent fields only where the original was optional", () => {
    const input = { feature: { kind: "fillet", radius: 2, note: null }, tags: [{ k: "a", v: null }] };
    expect(stripOptionalNulls(input, nested)).toEqual({ feature: { kind: "fillet", radius: 2 }, tags: [{ k: "a" }] });
    expect(stripOptionalNulls({ feature: null }, nested)).toEqual({ feature: null });
  });

  it("Anthropic strict closes objects and restates unsupported constraints; rejects open objects", () => {
    const s = toAnthropicSchema("t", nested, true) as any;
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.feature.additionalProperties).toBe(false);
    expect(s.properties.feature.properties.radius).toEqual({ type: "number", description: "(exclusiveMinimum: 0)" });
    expect(() => toAnthropicSchema("t", { type: "object", additionalProperties: true }, true)).toThrow(GatewayError);
    expect(toAnthropicSchema("t", nested, false)).toBe(nested);
  });

  it("Gemini keeps only its documented subset; const becomes enum", () => {
    const s = toGoogleSchema("t", { ...nested, $schema: "https://json-schema.org/draft/2020-12/schema", examples: [{}] }) as any;
    expect(s.$schema).toBeUndefined();
    expect(s.examples).toBeUndefined();
    expect(s.properties.feature.properties.kind).toEqual({ enum: ["fillet"] });
    expect(s.properties.feature.properties.radius).toEqual({ type: "number", description: "(exclusiveMinimum: 0)" });
  });

  it("rejects non-object tool schemas", () => {
    expect(() => toOpenAIStrictSchema("t", { type: "string" })).toThrow(/type "object"/);
  });
});

describe("pricing", () => {
  it("switches Gemini 3.8 Flash from introductory to standard pricing on 2027-01-01", () => {
    const p = profile("gemini-3.8-flash");
    expect(pricesAt(p.pricing, new Date("2026-12-31T23:00:00Z")).inputPerMTok).toBe(0.75);
    expect(pricesAt(p.pricing, new Date("2027-01-01T00:00:00Z"))).toMatchObject({ inputPerMTok: 1.5, outputPerMTok: 7.5, cacheReadPerMTok: 0.15 });
  });

  it("prices Anthropic 5m and 1h cache writes separately", () => {
    const usage = { ...emptyUsage(), cacheWriteTokens: 3000, cacheWrite1hTokens: 1000 };
    // Fable 5.1: 5m write $12.50, 1h write $20.
    expect(computeCostUsd(profile("claude-fable-5-1"), usage)).toBeCloseTo((2000 * 12.5 + 1000 * 20) / 1e6, 12);
  });

  it("Fable 5.1 cache reads are 0.025x input", () => {
    const p = profile("claude-fable-5-1");
    expect(p.pricing.cacheReadPerMTok / p.pricing.inputPerMTok).toBeCloseTo(0.025, 12);
  });
});

describe("built-in profiles", () => {
  it("all validate against the profile schema and carry verification metadata", () => {
    for (const p of BUILTIN_PROFILES) {
      expect(modelProfileSchema.safeParse(p).success, p.id).toBe(true);
      expect(p.verification.sources.length, p.id).toBeGreaterThan(0);
      expect(p.verification.verified.length, p.id).toBeGreaterThan(0);
      expect(p.defaultMaxOutputTokens, p.id).toBeLessThanOrEqual(p.maxOutputTokens);
    }
  });

  it("contains only model ids verified from the providers' docs", () => {
    expect(BUILTIN_PROFILES.map((p) => p.id)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gemini-3.8-flash",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash-lite",
      "gpt-oss-120b",
    ]);
  });

  it("encodes the forced-tool-choice and thinking restrictions of Opus 5.5 / Fable 5.1", () => {
    for (const id of ["claude-opus-5-5", "claude-fable-5-1"]) {
      expect(profile(id).capabilities.forcedToolChoice).toBe(false);
      expect(profile(id).reasoning.canDisable).toBe(false);
    }
    expect(profile("claude-opus-5").capabilities.forcedToolChoice).toBe(true);
    expect(profile("claude-haiku-4-5").reasoning.style).toBe("anthropic-budget");
    expect(profile("claude-haiku-4-5").contextWindow).toBe(200_000);
  });
});

describe("error normalization", () => {
  it("classifies SDK errors by status and name without string matching on known classes", () => {
    expect(normalizeProviderError("anthropic", Object.assign(new Error("x"), { status: 529 }))).toMatchObject({ code: "overloaded", retryable: true });
    expect(normalizeProviderError("openai", Object.assign(new Error("x"), { status: 401 }))).toMatchObject({ code: "auth", retryable: false });
    expect(normalizeProviderError("google", Object.assign(new Error("prompt is too long: 250000 tokens"), { status: 400 }))).toMatchObject({ code: "context_window_exceeded" });
    expect(normalizeProviderError("anthropic", Object.assign(new Error("context_management: Extra inputs are not permitted"), { status: 400 }))).toMatchObject({ code: "invalid_request" });
    const abort = new Error("aborted");
    abort.name = "APIUserAbortError";
    expect(normalizeProviderError("openai", abort)).toMatchObject({ code: "aborted" });
  });
});

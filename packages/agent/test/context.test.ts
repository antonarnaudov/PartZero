import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTINS } from "@aicad/cadscript";
import { CHECKS } from "@aicad/evals";
import { LLMGateway } from "@aicad/llm-gateway";
import { cadscriptReference, CLASSIFY_TOOL, defaultPromptsDir, loadPrompt, resolveModels } from "../src/index.js";

describe("prompts", () => {
  it("loads versioned role prompts with ids and content hashes", () => {
    for (const role of ["designer", "spec_writer", "triage"] as const) {
      const p = loadPrompt(role);
      expect(p.id).toBe(`${role}.v1`);
      expect(p.sha256).toMatch(/^[0-9a-f]{12}$/);
      expect(p.text.length).toBeGreaterThan(400);
      expect(p.text).toBe(readFileSync(join(defaultPromptsDir(), `${role}.v1.md`), "utf8").trim());
    }
  });

  it("prefers a per-model-family variant file and falls back to the default", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompts-"));
    writeFileSync(join(dir, "designer.v2.md"), "default v2");
    writeFileSync(join(dir, "designer.v2.gpt-6.md"), "gpt-6 v2");
    expect(loadPrompt("designer", { version: "v2", variant: "gpt-6", dir })).toMatchObject({ id: "designer.v2.gpt-6", variant: "gpt-6", text: "gpt-6 v2" });
    expect(loadPrompt("designer", { version: "v2", variant: "claude-5", dir })).toMatchObject({ id: "designer.v2", text: "default v2" });
    expect(loadPrompt("designer", { version: "v2", variant: "claude-5", dir }).variant).toBeUndefined();
    expect(() => loadPrompt("triage", { version: "v2", dir })).toThrow(/no prompt triage\.v2\.md/);
  });

  it("the spec writer's check reference covers every check of the DSL", () => {
    const text = loadPrompt("spec_writer").text;
    for (const c of CHECKS) expect(text, c).toContain(`\`${c}\``);
  });
});

describe("CadScript reference (generated from @aicad/std)", () => {
  const ref = cadscriptReference();

  it("documents every builtin with its signature and keeps the language rules verbatim", () => {
    for (const b of BUILTINS) expect(ref, b).toMatch(new RegExp(`\`${b}[(:]`));
    expect(ref).toContain("## Rules of CadScript v0");
    expect(ref).toContain("### `revolve(sketch: Sketch, options: RevolveOptions): Revolve`");
    expect(ref).toContain("- `radius: number` — Radius, mm. Must be greater than 1e-6. (Radius, not diameter: an M5 clearance hole is `2.75`.)");
    expect(ref).not.toContain("{@link");
    expect(ref).not.toContain("[kind]");
  });

  it("is deterministic and compact (a cached prefix of ~3k tokens)", () => {
    expect(cadscriptReference()).toBe(ref);
    expect(ref.length).toBeGreaterThan(6000);
    expect(ref.length).toBeLessThan(16000);
  });
});

describe("model routing", () => {
  const gateway = new LLMGateway();

  it("defaults to the gateway router's roles, with per-role output ceilings", () => {
    expect(resolveModels(gateway)).toEqual({
      triage: { model: "claude-haiku-4-5", maxOutputTokens: 1024 },
      designer: { model: "claude-opus-5-5", effort: "medium", maxOutputTokens: 16000 },
      spec_writer: { model: "claude-opus-5-5", effort: "high", maxOutputTokens: 12000 },
    });
  });

  it("a designer override brings its own spec writer and its provider's small triage model", () => {
    expect(resolveModels(gateway, { designer: "gpt-6-astra" })).toMatchObject({
      designer: { model: "gpt-6-astra" },
      spec_writer: { model: "gpt-6-astra", effort: "high" },
      triage: { model: "gpt-6-luna" },
    });
    expect(resolveModels(gateway, { designer: "gemini-3.1-pro-preview" }).triage.model).toBe("gemini-3.5-flash-lite");
    expect(resolveModels(gateway, { designer: "gpt-oss-120b" }).triage.model).toBe("gpt-oss-120b");
    expect(() => resolveModels(gateway, { designer: "gpt-7" })).toThrow(/No model profile 'gpt-7'/);
  });

  it("the triage tool is strict and closed", () => {
    expect(CLASSIFY_TOOL.strict).toBe(true);
    expect(CLASSIFY_TOOL.inputSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["kind", "complexity", "needs_clarification", "reason"] });
  });
});

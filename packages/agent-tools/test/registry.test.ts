import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { toAnthropicSchema, toGoogleSchema, toOpenAIStrictSchema } from "@aicad/llm-gateway";
import { defineTool, designRegistry, designerRegistry, specWriterRegistry, toStrictJsonSchema, ToolRegistry, DESIGNER_TOOLS, SPEC_WRITER_TOOLS } from "../src/index.js";

type Json = Record<string, unknown>;

/** Every object schema node, with its path. */
function objectNodes(node: unknown, path = "#"): { path: string; node: Json }[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => objectNodes(n, `${path}/${i}`));
  if (typeof node !== "object" || node === null) return [];
  const n = node as Json;
  const here = n["type"] === "object" ? [{ path, node: n }] : [];
  return [...here, ...Object.entries(n).flatMap(([k, v]) => objectNodes(v, `${path}/${k}`))];
}

describe("tool schemas", () => {
  const registry = designRegistry();

  it("has the v0 tool set, sorted by name", () => {
    expect(registry.names()).toEqual([...registry.names()].sort());
    expect(registry.names()).toEqual(
      ["apply_cadscript", "ask_user", "checkpoint", "get_code", "ir_summary", "measure", "propose", "rollback", "run_tests", "set_spec_tests", "submit_spec"],
    );
    expect(designerRegistry().names()).toEqual([...DESIGNER_TOOLS]);
    expect(specWriterRegistry().names()).toEqual([...SPEC_WRITER_TOOLS]);
  });

  for (const def of designRegistry().defs()) {
    it(`${def.name}: strict, closed objects, valid JSON Schema, accepted by every provider rewrite`, () => {
      expect(def.strict).toBe(true);
      expect(def.inputSchema["type"]).toBe("object");
      expect(def.inputSchema["$schema"]).toBeUndefined();
      for (const { path, node } of objectNodes(def.inputSchema)) {
        expect(node["additionalProperties"], path).toBe(false);
        expect(Array.isArray(node["required"]), path).toBe(true);
      }
      // No keywords that Anthropic strict mode rejects survive (they are restated in descriptions).
      expect(JSON.stringify(def.inputSchema)).not.toMatch(/"(minimum|maximum|minItems|maxItems|minLength|maxLength|pattern)"/);
      const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
      expect(() => ajv.compile(def.inputSchema)).not.toThrow();
      expect(() => toAnthropicSchema(def.name, def.inputSchema, true)).not.toThrow();
      expect(() => toOpenAIStrictSchema(def.name, def.inputSchema)).not.toThrow();
      expect(() => toGoogleSchema(def.name, def.inputSchema)).not.toThrow();
      expect(def.description.length).toBeGreaterThan(40);
    });
  }

  it("is byte-identical across registries (stable cache prefix)", () => {
    expect(JSON.stringify(designerRegistry().defs())).toBe(JSON.stringify(designerRegistry().defs()));
    const shuffled = new ToolRegistry([...designRegistry().subset(["run_tests", "get_code", "apply_cadscript"]).names()].reverse().map((n) => designRegistry().get(n)!));
    expect(shuffled.defs().map((d) => d.name)).toEqual(["apply_cadscript", "get_code", "run_tests"]);
  });

  it("turns multi-type arrays into anyOf", () => {
    const s = toStrictJsonSchema(z.object({ v: z.union([z.string(), z.number()]).describe("value") }));
    expect((s["properties"] as Json)["v"]).toEqual({ description: "value", anyOf: [{ type: "string" }, { type: "number" }] });
    for (const def of designRegistry().defs()) expect(JSON.stringify(def.inputSchema), def.name).not.toMatch(/"type":\[/);
  });

  it("restates dropped constraints in the description and hides zod's safe-integer range", () => {
    const s = toStrictJsonSchema(z.object({ n: z.number().int().min(1).max(3).describe("count"), k: z.number().int() }));
    expect((s["properties"] as Json)["n"]).toEqual({ type: "integer", description: "count (minimum: 1, maximum: 3)" });
    expect((s["properties"] as Json)["k"]).toEqual({ type: "integer" });
  });
});

describe("ToolRegistry.execute", () => {
  const echo = defineTool({
    name: "echo",
    description: "Echo a message back, optionally repeated.",
    input: z.object({ msg: z.string(), times: z.number().int().min(1).max(3).optional() }),
    run: (input) => ({ text: input.msg.repeat(input.times ?? 1) }),
  });
  const boom = defineTool({ name: "boom", description: "Always throws.", input: z.object({}), run: () => { throw new Error("kaput"); } });
  const registry = new ToolRegistry<null>([echo, boom]);

  it("validates input with zod (constraints dropped from the schema are still enforced)", async () => {
    expect(await registry.execute({ name: "echo", input: { msg: "a", times: 2 } }, null)).toEqual({ text: "aa" });
    const bad = await registry.execute({ name: "echo", input: { msg: "a", times: 9 } }, null);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Invalid input for echo: times/);
  });

  it("maps OpenAI strict-mode nulls back to absent optional fields", async () => {
    expect(await registry.execute({ name: "echo", input: { msg: "x", times: null } }, null)).toEqual({ text: "x" });
  });

  it("turns unknown tools, unparseable arguments and exceptions into error results", async () => {
    expect(await registry.execute({ name: "nope", input: {} }, null)).toMatchObject({ isError: true, text: expect.stringMatching(/Available: boom, echo/) });
    expect(await registry.execute({ name: "echo", input: {}, inputError: "not JSON", rawInput: '{"msg": "tr' }, null)).toMatchObject({
      isError: true,
      text: expect.stringMatching(/could not be parsed/),
    });
    expect(await registry.execute({ name: "boom", input: {} }, null)).toMatchObject({ isError: true, text: "boom failed: kaput" });
  });

  it("rejects duplicate and non-snake_case tool names", () => {
    expect(() => new ToolRegistry([echo, echo])).toThrow(/duplicate/);
    expect(() => new ToolRegistry([{ ...echo, name: "Echo" }])).toThrow(/snake_case/);
  });
});

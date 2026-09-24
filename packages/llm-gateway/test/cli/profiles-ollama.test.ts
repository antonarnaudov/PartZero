import { describe, expect, it } from "vitest";
import { BUILTIN_CLI_PROFILES, BUILTIN_LOCAL_PROFILES, BUILTIN_PROFILES, ollamaProfile, profileFromDiscovery, smallModelFor } from "../../src/builtin-profiles.js";
import { ollamaBaseUrlProblem, ollamaModelInfo, ollamaProfilesFrom, parseOllamaList, probeOllama } from "../../src/cli/ollama.js";
import { parseMcpList, parseOpencodeModels } from "../../src/cli/opencode.js";
import { LLMGateway } from "../../src/gateway.js";
import { modelProfileSchema, ProfileRegistry, type ModelProfile } from "../../src/profile.js";
import { ReplayTransport } from "../../src/transport/transport.js";
import { CLI_PROVIDER_IDS, PROVIDER_KINDS, providerKind } from "../../src/types.js";

const all = [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES, ...BUILTIN_LOCAL_PROFILES];
const byId = (id: string): ModelProfile => all.find((p) => p.id === id)!;

describe("provider kinds", () => {
  it("every provider has a kind; CLI ids are the cli kind", () => {
    expect(providerKind("anthropic")).toBe("api");
    expect(providerKind("ollama")).toBe("local");
    for (const id of CLI_PROVIDER_IDS) expect(PROVIDER_KINDS[id]).toBe("cli");
  });
});

describe("built-in CLI and local profiles (§9.1, §10)", () => {
  it("validate, carry verification metadata, and keep the API list unchanged", () => {
    for (const p of [...BUILTIN_CLI_PROFILES, ...BUILTIN_LOCAL_PROFILES]) {
      const parsed = modelProfileSchema.safeParse(p);
      expect(parsed.success, `${p.id}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      expect(p.verification.sources.length, p.id).toBeGreaterThan(0);
      expect(p.verification.verified.length, p.id).toBeGreaterThan(0);
      expect(p.defaultMaxOutputTokens, p.id).toBeLessThanOrEqual(p.maxOutputTokens);
    }
    expect(BUILTIN_CLI_PROFILES.map((p) => p.id)).toEqual([
      "claude-cli:opus",
      "claude-cli:sonnet",
      "claude-cli:haiku",
      "claude-cli:fable",
      "gemini-cli:pro",
      "gemini-cli:flash",
      "gemini-cli:flash-lite",
      "gemini-cli:auto",
      "codex-cli:default",
      "codex-cli:gpt-6-sol",
      "codex-cli:gpt-6-luna",
      "cursor-agent:auto",
    ]);
    expect(BUILTIN_PROFILES.every((p) => p.billing === "metered" && p.cli === undefined)).toBe(true);
    expect(() => new ProfileRegistry(all)).not.toThrow();
  });

  it("CLI profiles: subscription billing, notional list pricing where an API model exists, zeros otherwise", () => {
    const opus = byId("claude-cli:opus");
    expect(opus).toMatchObject({ provider: "claude-cli", billing: "subscription", toolSchemaStyle: "cli-envelope", family: "claude-opus", cli: { agent: "claude", modelArg: "opus", envelopeVia: "json-schema", modes: ["completion", "runtime"] } });
    expect(opus.pricing.inputPerMTok).toBe(byId("claude-opus-5-5").pricing.inputPerMTok);
    expect(opus.pricing.source).toMatch(/^notional/);
    expect(opus.cli?.effortArg).toEqual({ low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    expect(byId("claude-cli:haiku").reasoning.efforts).toEqual([]);
    expect(byId("claude-cli:haiku").contextWindow).toBe(200_000);
    expect(byId("gemini-cli:pro").pricing.inputPerMTok).toBe(0);
    expect(byId("gemini-cli:pro").cli?.envelopeVia).toBe("mcp-submit");
    expect(byId("codex-cli:default").cli?.modelArg).toBeNull();
    expect(byId("codex-cli:gpt-6-sol").cli?.effortArg).toEqual({ low: "low", medium: "medium", high: "high", xhigh: "xhigh" });
    expect(byId("cursor-agent:auto").quirks.join(" ")).toMatch(/BLOCKED/);
    expect(byId("claude-cli:opus").displayName).toBe("Claude Opus (Claude Code, your plan)");
  });

  it("the judge-family rule can pair CLI profiles (opus designer vs fable judge)", () => {
    expect(byId("claude-cli:opus").family).not.toBe(byId("claude-cli:fable").family);
  });

  it("schema refinements: cli block <-> CLI provider, local block -> local billing", () => {
    const opus = byId("claude-cli:opus");
    const { cli: _cli, ...noCli } = opus;
    expect(modelProfileSchema.safeParse(noCli).success).toBe(false);
    expect(modelProfileSchema.safeParse({ ...opus, cli: { ...opus.cli, agent: "gemini" } }).success).toBe(false);
    expect(modelProfileSchema.safeParse({ ...opus, billing: "local" }).success).toBe(false);
    expect(modelProfileSchema.safeParse({ ...byId("claude-opus-5-5"), cli: opus.cli }).success).toBe(false);
    const local = byId("ollama:qwen3:8b");
    expect(modelProfileSchema.safeParse({ ...local, billing: "metered" }).success).toBe(false);
    const { local: _l, ...noLocal } = local;
    expect(modelProfileSchema.safeParse({ ...noLocal, provider: "ollama" }).success).toBe(false);
    const parsed = modelProfileSchema.parse({ ...byId("gpt-oss-120b"), billing: undefined });
    expect(parsed.billing).toBe("metered");
  });

  it("smallModelFor is one table for every host", () => {
    expect(smallModelFor("anthropic")).toBe("claude-haiku-4-5");
    expect(smallModelFor("claude-cli")).toBe("claude-cli:haiku");
    expect(smallModelFor("gemini-cli")).toBe("gemini-cli:flash-lite");
    expect(smallModelFor("codex-cli")).toBe("codex-cli:gpt-6-luna");
    expect(smallModelFor("opencode")).toBeNull();
    expect(smallModelFor("ollama")).toBeNull();
    for (const p of ["anthropic", "openai", "google", "claude-cli", "gemini-cli", "codex-cli"] as const) expect(all.some((x) => x.id === smallModelFor(p))).toBe(true);
  });
});

describe("model discovery", () => {
  it("opencode `models --verbose`: tool-capable only, Anthropic hidden, billing from models.dev cost", () => {
    const text = [
      "opencode/grok-code",
      '{ "name": "Grok Code Fast", "tool_call": true, "cost": { "input": 0, "output": 0 }, "limit": { "context": 256000 } }',
      "openrouter/qwen/qwen3-coder",
      "{",
      '  "name": "Qwen3 Coder",',
      '  "tool_call": true,',
      '  "cost": { "input": 0.2, "output": 0.8 },',
      '  "limit": { "context": 262144 },',
      '  "modalities": { "input": ["text"] }',
      "}",
      "openrouter/some/no-tools",
      '{ "name": "No tools", "tool_call": false }',
      "anthropic/claude-sonnet-5",
      '{ "name": "Claude Sonnet 5", "tool_call": true }',
    ].join("\n");
    const models = parseOpencodeModels(text);
    expect(models.map((m) => [m.modelArg, m.billing, m.contextWindow])).toEqual([
      ["opencode/grok-code", "subscription", 256000],
      ["openrouter/qwen/qwen3-coder", "metered", 262144],
    ]);
    const p = profileFromDiscovery("opencode", models[1]!, undefined, new Date("2026-09-24T00:00:00Z"));
    expect(modelProfileSchema.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ id: "opencode:openrouter/qwen/qwen3-coder", provider: "opencode", billing: "metered", contextWindow: 262144, cli: { agent: "opencode", modelArg: "openrouter/qwen/qwen3-coder", envelopeVia: "mcp-submit", discoveredAt: "2026-09-24T00:00:00.000Z" } });
    const codex = profileFromDiscovery("codex-cli", { modelArg: "gpt-6-sol", displayName: "GPT-6 Sol", vendor: "openai", family: "gpt-6", tools: true, vision: true, contextWindow: null, billing: "subscription" }, byId("gpt-6-sol"));
    expect(codex.pricing.inputPerMTok).toBe(byId("gpt-6-sol").pricing.inputPerMTok);
    expect(codex.cli?.envelopeVia).toBe("json-schema");
  });

  it("parses `opencode mcp list` names and `ollama list` tags", () => {
    expect(parseMcpList("\u001b[32m●\u001b[0m  ✓ supabase  connected\n● ✗ stripe failed\nNo MCP servers\n")).toEqual(["supabase", "stripe"]);
    // 1.17.10 layout (recorded by test/cli/real-opencode.test.ts): box glyphs, error detail lines, a summary line.
    expect(parseMcpList("┌  MCP Servers\n│\n●  ✗ usersrv \u001b[90mfailed\n│      MCP error -32000: Connection closed\n│      \u001b[90m/usr/bin/touch /x\n│\n└  2 server(s)\n")).toEqual(["usersrv"]);
    expect(parseOllamaList("NAME          ID              SIZE      MODIFIED\nqwen3:8b      500a1f067a9f    5.2 GB    2 days ago\ngpt-oss:20b   aa4295ac10c3    13 GB     5 weeks ago\n")).toEqual(["qwen3:8b", "gpt-oss:20b"]);
  });
});

describe("Ollama (local profiles over the OpenAI-compatible /v1 endpoint)", () => {
  const show = (caps: string[], ctx: number) => ({ capabilities: caps, details: { family: "qwen3", parameter_size: "8.2B" }, model_info: { "general.architecture": "qwen3", "qwen3.context_length": ctx } });

  it("probeOllama: version, tags and /api/show capabilities; profiles only for tool-capable models", async () => {
    const calls: string[] = [];
    const fetch = async (url: string, init?: { body?: string }) => {
      calls.push(`${url} ${init?.body ?? ""}`.trim());
      const path = new URL(url).pathname;
      const body =
        path === "/api/version"
          ? { version: "0.34.2" }
          : path === "/api/tags"
            ? { models: [{ name: "qwen3:8b" }, { name: "llava:7b" }, { name: "bad name!" }] }
            : JSON.parse(init?.body ?? "{}").model === "qwen3:8b"
              ? show(["completion", "tools", "thinking"], 40960)
              : show(["completion", "vision"], 4096);
      return { ok: true, status: 200, json: async () => body };
    };
    const status = await probeOllama("http://127.0.0.1:11434", { fetch });
    expect(status).toMatchObject({ running: true, version: "0.34.2", detail: "2 model(s), 1 with tool calling" });
    expect(status.models.map((m) => [m.tag, m.tools, m.vision, m.thinking, m.contextLength])).toEqual([
      ["qwen3:8b", true, false, true, 40960],
      ["llava:7b", false, true, false, 4096],
    ]);
    const profiles = ollamaProfilesFrom(status);
    expect(profiles.map((p) => p.id)).toEqual(["ollama:qwen3:8b"]);
    expect(profiles[0]).toMatchObject({
      provider: "openai-compat",
      apiModelId: "qwen3:8b",
      billing: "local",
      contextWindow: 32768,
      compat: { baseURL: "http://127.0.0.1:11434/v1" },
      local: { baseURL: "http://127.0.0.1:11434", tag: "qwen3:8b", numCtx: 32768, think: true },
      reasoning: { style: "compat-reasoning-effort" },
    });
    expect(calls).toContain('http://127.0.0.1:11434/api/show {"model":"qwen3:8b"}');
  });

  it("not running, credentials in the URL, and non-loopback URLs are handled without throwing", async () => {
    const down = await probeOllama("http://127.0.0.1:1", { fetch: async () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(down).toMatchObject({ running: false, models: [] });
    expect(ollamaBaseUrlProblem("http://user:pw@127.0.0.1:11434")).toMatch(/credentials/);
    expect(ollamaBaseUrlProblem("http://10.0.0.5:11434")).toMatch(/loopback/);
    expect(ollamaBaseUrlProblem("http://10.0.0.5:11434", { allowRemote: true })).toBeNull();
    expect((await probeOllama("http://10.0.0.5:11434", { fetch: async () => Promise.reject(new Error("not called")) })).detail).toMatch(/refused/);
  });

  it("numCtx is capped at 32k and defaults to 8k; default local profiles are valid and tool-capable", () => {
    expect(ollamaProfile(ollamaModelInfo("tiny:1b", { capabilities: ["tools"] })).local?.numCtx).toBe(8192);
    expect(BUILTIN_LOCAL_PROFILES.map((p) => p.id)).toEqual(["ollama:qwen3:8b", "ollama:gpt-oss:20b", "ollama:qwen3-coder:30b"]);
    expect(BUILTIN_LOCAL_PROFILES.every((p) => p.capabilities.tools && p.billing === "local")).toBe(true);
  });

  it("routes an ollama profile through the openai-compat adapter to the local /v1 endpoint at zero cost", async () => {
    const replay = new ReplayTransport([
      {
        provider: "openai-compat",
        operation: "openai-compat.chat.completions.create",
        mode: "send",
        request: {},
        response: { id: "c1", object: "chat.completion", model: "qwen3:8b", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      },
    ]);
    const gw = new LLMGateway({ profiles: [...BUILTIN_PROFILES, ...BUILTIN_LOCAL_PROFILES], transports: { "openai-compat": replay } });
    const r = await gw.chat({ model: "ollama:qwen3:8b", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
    expect(replay.calls[0]).toMatchObject({ endpoint: "http://127.0.0.1:11434/v1", payload: { model: "qwen3:8b" } });
    expect(r).toMatchObject({ billing: "local", costUsd: 0 });
  });
});

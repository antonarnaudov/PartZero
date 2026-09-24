/**
 * Live Claude Code smoke (docs/CLI-PROVIDERS.md §13.2-§13.3). NEVER runs by default: it spends the owner's plan.
 *
 *   AICAD_LIVE_CLI=claude pnpm --filter @aicad/llm-gateway test:live:cli
 *
 * S0  detect + lockdown + auth probe (no model call)
 * S1  completion, json-schema envelope, claude-cli:haiku, through LLMGateway (1 invocation)
 * S1c completion, json-schema envelope, the prompt provokes a direct `classify` call (§5.6 amendment 2; 1 invocation)
 * S1b completion, plain text, no tools (1 invocation)
 * With AICAD_LIVE_CLI_EXTRA=1 also:
 * S0b logged-out signature from a throwaway CLAUDE_CONFIG_DIR (expected: no model call)
 * S3  runtime-mode invocation with a stub MCP server (`ping`), stdin stream-json input, closeInput() (1 invocation)
 *
 * AICAD_RECORD_CLI_FIXTURES=<dir> writes the raw stdout JSONL of each step to <dir> (scrub before committing).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_CLI_PROFILES, BUILTIN_PROFILES } from "../../src/builtin-profiles.js";
import { CliAdapter } from "../../src/cli/adapter.js";
import { cliEnvForBinary } from "../../src/cli/base.js";
import type { CliEvent } from "../../src/cli/events.js";
import type { McpAttachment } from "../../src/cli/mcp.js";
import type { CliBinary, CliInvocation } from "../../src/cli/provider.js";
import { CLI_PROVIDERS } from "../../src/cli/registry.js";
import { CliTransport } from "../../src/cli/transport.js";
import { createCliWorkspace } from "../../src/cli/workspace.js";
import { GatewayError } from "../../src/errors.js";
import { LLMGateway } from "../../src/gateway.js";
import type { PlanUsage, ToolDef } from "../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const LIVE_CLI = new Set((process.env["AICAD_LIVE_CLI"] ?? "").split(",").filter(Boolean));
const EXTRA = process.env["AICAD_LIVE_CLI_EXTRA"] === "1";
const RECORD_DIR = process.env["AICAD_RECORD_CLI_FIXTURES"];

function recorder(name: string): ((line: string) => void) | undefined {
  if (RECORD_DIR === undefined) return undefined;
  mkdirSync(RECORD_DIR, { recursive: true });
  const file = join(RECORD_DIR, `${name}.jsonl`);
  writeFileSync(file, "");
  return (line) => appendFileSync(file, `${line}\n`);
}

const classify: ToolDef = {
  name: "classify",
  description: "Classify the user's request for the CAD app.",
  inputSchema: {
    type: "object",
    properties: { kind: { type: "string", enum: ["quick_edit", "new_part", "question"] } },
    required: ["kind"],
    additionalProperties: false,
  },
};

function aicadSessionDirs(): string[] {
  const projects = join(homedir(), ".claude", "projects");
  if (!existsSync(projects)) return [];
  return readdirSync(projects).filter((n) => n.includes("aicad-cli"));
}

describe.skipIf(!LIVE_CLI.has("claude"))("claude-cli live smoke (spends plan usage)", () => {
  const provider = CLI_PROVIDERS.get("claude-cli")!;
  const env = process.env as Record<string, string>;
  let binary: CliBinary | null = null;
  let plan: PlanUsage | null = null;
  let stop: string | null = null;

  const gateway = (rec?: (line: string) => void, parentEnv: Record<string, string> = env): LLMGateway => {
    const transport = new CliTransport({
      provider,
      binary: async () => binary!,
      env: () => parentEnv,
      onPlanUsage: (u) => {
        plan = u;
      },
      ...(rec === undefined ? {} : { onStdoutLine: rec }),
    });
    return new LLMGateway({
      profiles: [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES],
      adapters: { "claude-cli": new CliAdapter(provider) },
      transports: { "claude-cli": transport },
    });
  };

  const planGate = (): void => {
    const p = plan as PlanUsage | null;
    if (p === null) return;
    const five = p.windows.find((w) => w.id === "five_hour")?.utilization ?? 0;
    if (p.status !== "allowed" || five >= 0.8) stop = `plan usage ${p.status}, five-hour utilization ${five}`;
  };

  it("S0: detect, lockdown and auth (no model call)", async () => {
    const d = await provider.detect({ overridePath: null, env, extraDirs: [], loginShell: false });
    console.log(`[S0] ${d.status}: ${d.detail}`);
    if (d.status !== "ready" || d.binary === null) {
      stop = `not ready: ${d.detail}`;
      return;
    }
    expect(["verified", "static"]).toContain(d.lockdown?.level);
    const auth = await provider.authStatus(d.binary, env);
    console.log(`[S0] auth ${auth.state} method=${auth.method} plan=${auth.plan} billing=${auth.billing}`);
    if (auth.state !== "logged_in") {
      stop = `auth ${auth.state}`;
      return;
    }
    binary = d.binary;
  }, 60_000);

  it("S1: completion with the json-schema envelope (1 invocation)", async () => {
    if (stop !== null || binary === null) return console.log(`[S1] skipped: ${stop}`);
    const before = aicadSessionDirs().length;
    const task = gateway(recorder("completion-json-schema")).createTask({ id: "live-s1", budgetUsd: 0.25 });
    const r = await task.chat({
      model: "claude-cli:haiku",
      system: [{ type: "text", text: "You are the triage step of a CAD app. Classify the request by calling the classify tool. Do not answer in text." }],
      tools: [classify],
      messages: [{ role: "user", content: [{ type: "text", text: "make the plate 2 mm thicker" }] }],
      providerOptions: { cli: { limits: { wallMs: 120_000 } } },
    });
    const events = (r.providerRaw as { events: CliEvent[] }).events;
    const init = events.find((e) => e.type === "init");
    console.log(`[S1] cost ≈ $${r.costUsd.toFixed(4)} (${r.costSource}), turns ${r.cli?.turns}, models ${r.cli?.modelsUsed.join(",")}`);
    expect(init?.type === "init" ? init.tools : null).toEqual(["StructuredOutput"]);
    expect(r.billing).toBe("subscription");
    expect(r.costSource).toBe("provider");
    expect(r.cli?.envelopeVia).toBe("json-schema");
    const call = r.message.content.find((b) => b.type === "tool_use");
    expect(call?.type === "tool_use" ? call.name : null).toBe("classify");
    expect(aicadSessionDirs().length).toBe(before);
    expect(task.ledger).toHaveLength(1);
    planGate();
  }, 180_000);

  it("S1c: a direct call to an application tool is refused by Claude, not a lockdown violation (1 invocation, §5.6 amendment 2)", async () => {
    if (stop !== null || binary === null) return console.log(`[S1c] skipped: ${stop}`);
    // The S1 failure mode, provoked: the prompt asks for a direct call to `classify`, which only exists as an
    // application tool in the envelope appendix. Claude answers it with an error; the model then uses StructuredOutput.
    const r = await gateway(recorder("completion-unoffered-tool")).chat({
      model: "claude-cli:haiku",
      system: [{ type: "text", text: "You are the triage step of a CAD app. Your first action must be a tool call named exactly classify (not StructuredOutput), with the input {\"kind\": ...}. Only after its result, return the envelope. Do not answer in text." }],
      tools: [classify],
      messages: [{ role: "user", content: [{ type: "text", text: "make the plate 2 mm thicker" }] }],
      providerOptions: { cli: { limits: { wallMs: 120_000 } } },
    });
    const events = (r.providerRaw as { events: CliEvent[] }).events;
    const direct = events.filter((e) => e.type === "tool_call").map((e) => (e.type === "tool_call" ? e.qualifiedName : ""));
    console.log(`[S1c] cost ≈ $${r.costUsd.toFixed(4)}, turns ${r.cli?.turns}, direct calls ${JSON.stringify(direct)}, warnings ${JSON.stringify(r.warnings)}`);
    if (direct.length > 0) expect(r.warnings.some((w) => w.includes("not a lockdown violation"))).toBe(true);
    const call = r.message.content.find((b) => b.type === "tool_use");
    expect(call?.type === "tool_use" ? call.name : null).toBe("classify");
    planGate();
  }, 180_000);

  it("S1b: plain completion without tools (1 invocation)", async () => {
    if (stop !== null || binary === null) return console.log(`[S1b] skipped: ${stop}`);
    const r = await gateway(recorder("completion-plain")).chat({
      model: "claude-cli:haiku",
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly the word: pong" }] }],
      providerOptions: { cli: { limits: { wallMs: 120_000 } } },
    });
    const text = r.message.content.find((b) => b.type === "text");
    console.log(`[S1b] cost ≈ $${r.costUsd.toFixed(4)}, text ${JSON.stringify(text?.type === "text" ? text.text : null)}`);
    expect(text?.type === "text" ? text.text.toLowerCase() : "").toContain("pong");
    expect(r.cli?.envelopeVia).toBeNull();
    planGate();
  }, 180_000);

  it.skipIf(!EXTRA)("S0b: logged-out signature from a throwaway CLAUDE_CONFIG_DIR", async () => {
    if (binary === null) return console.log(`[S0b] skipped: ${stop}`);
    const configDir = mkdtempSync(join(tmpdir(), "aicad-claude-config-"));
    try {
      const err = await gateway(recorder("not-logged-in"), { ...env, CLAUDE_CONFIG_DIR: configDir })
        .chat({ model: "claude-cli:haiku", messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK" }] }], providerOptions: { cli: { limits: { maxTurns: 1, wallMs: 60_000 } } } })
        .then(
          () => null,
          (e: unknown) => e,
        );
      console.log(`[S0b] ${err instanceof GatewayError ? `${err.code}: ${err.message}` : "no error (a login was found)"}`);
      if (err instanceof GatewayError) expect(err.code).toBe("not_logged_in");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!EXTRA)("S3: runtime invocation with a stub MCP server (1 invocation)", async () => {
    if (stop !== null || binary === null) return console.log(`[S3] skipped: ${stop}`);
    const ws = await createCliWorkspace({ runId: randomUUID() });
    try {
      const mcp: McpAttachment = {
        serverName: "cad",
        command: process.execPath,
        args: [join(here, "fixtures", "ping-mcp.mjs")],
        env: {},
        ticketEnv: "AICAD_MCP_TICKET",
        toolNames: ["ping"],
        callTimeoutMs: 30_000,
      };
      const inv: CliInvocation = {
        runId: randomUUID(),
        mode: "runtime",
        binary,
        workspace: ws,
        model: "haiku",
        effort: null,
        systemPrompt: "You are a test agent. Use only the tools you are given.",
        prompt: "Call the ping tool exactly once, then reply with the single word: done",
        images: [],
        structured: null,
        mcp,
        resume: null,
        limits: { maxTurns: 4, wallMs: 120_000, stallMs: 60_000 },
        env: cliEnvForBinary(binary, env, ws.tmp, { AICAD_MCP_TICKET: "live-test-ticket-not-a-secret" }),
      };
      const rec = recorder("runtime-mcp-ping");
      const run = provider.run(inv, rec === undefined ? {} : { onStdoutLine: rec });
      const events: CliEvent[] = [];
      for await (const e of run.events) {
        events.push(e);
        if (e.type === "result") run.closeInput();
      }
      const exit = await run.done;
      const init = events.find((e) => e.type === "init");
      const result = events.find((e) => e.type === "result");
      console.log(`[S3] exit ${exit.code} ${exit.reason}, cost ≈ $${result?.type === "result" ? result.costUsd : "?"}`);
      expect(exit.failure).toBeNull();
      expect(init?.type === "init" ? init.tools : null).toEqual(["mcp__cad__ping"]);
      expect(init?.type === "init" ? init.mcpServers : null).toEqual([{ name: "cad", status: "connected" }]);
      expect(events.some((e) => e.type === "tool_call" && e.qualifiedName === "mcp__cad__ping")).toBe(true);
      expect(events.some((e) => e.type === "tool_result" && e.text === "pong")).toBe(true);
    } finally {
      await ws.dispose();
    }
  }, 180_000);
});

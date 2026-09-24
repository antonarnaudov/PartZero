/**
 * Live Claude Code smoke for agent-runtime mode (docs/CLI-PROVIDERS.md §13.3, profile `cli-smoke-claude`).
 * NEVER runs by default or in CI: it spends the owner's Claude plan.
 *
 *   AICAD_LIVE_CLI=claude pnpm --filter @aicad/agent test:live:cli
 *
 * S0  detect + lockdown + auth probe (no model call); later steps are skipped when not ready.
 * S2  runtime BUILD: forced quick_edit on the NEMA 17 plate ("make the plate 2 mm thicker"), designer
 *     claude-cli:haiku, BUILD limits {maxTurns: 8, wallMs: 180 s}, notional budget $0.25 (1 CLI invocation).
 * S2n (AICAD_LIVE_CLI_NUDGE=1) runtime BUILD where the model ends its turn without proposing: the nudge
 *     goes to the running process as a stream-json user message (§15 A1; 1 CLI invocation, several turns).
 * S3  (AICAD_LIVE_CLI_SPEC=1) runtime SPEC + BUILD on a tiny design request (2 CLI invocations).
 *
 * The run aborts when the first plan-usage report says the plan is not "allowed" or the five-hour
 * window is at 80 % or more. The engine is the Forge CLI (else the OCCT oracle); without one, S2/S3 skip.
 *
 * AICAD_RECORD_CLI_FIXTURES=<dir> writes S2's scrubbed stdout (`runtime-build.jsonl`) and the engine
 * reports it needed (`runtime-build.engine.json`): the offline replay test (cli-replay.test.ts) uses them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURE_SCHEMA, ForgeCliEngine, irHash, OracleEngine, type Engine, type FixtureEntry } from "@aicad/evals";
import { BUILTIN_CLI_PROFILES, BUILTIN_PROFILES, LLMGateway, type CliProviderId, type PlanUsage } from "@aicad/llm-gateway";
import { CLI_PROVIDERS, defaultWorkspaceRoot, type CliBinary } from "@aicad/llm-gateway/cli";
import { createMcpHost, nodeShimCommand } from "@aicad/mcp-server";
import { CliAgentRuntime } from "../../src/cli-runtime.js";
import { Agent, type AgentOptions } from "../../src/index.js";
import { Scrubber } from "../scrub.js";

const LIVE_CLI = new Set((process.env["AICAD_LIVE_CLI"] ?? "").split(",").filter(Boolean));
const RECORD_DIR = process.env["AICAD_RECORD_CLI_FIXTURES"];
const NEMA = readFileSync(fileURLToPath(new URL("../../../../corpus/makerbench/t1-nema17-plate.cad.ts", import.meta.url)), "utf8");

/** Records every evaluation as a fixture entry (so the offline replay has the same engine answers). */
class RecordingEngine implements Engine {
  readonly kind: string;
  readonly entries: FixtureEntry[] = [];
  readonly #inner: Engine;
  constructor(inner: Engine) {
    this.#inner = inner;
    this.kind = inner.kind;
  }
  availability() {
    return this.#inner.availability();
  }
  async evaluate(...args: Parameters<Engine["evaluate"]>) {
    const report = await this.#inner.evaluate(...args);
    const hash = irHash(args[0]);
    if (!this.entries.some((e) => e.ir_sha256 === hash)) this.entries.push({ label: `live-${this.entries.length + 1}`, ir_sha256: hash, report });
    return report;
  }
}

async function liveEngine(): Promise<Engine | null> {
  for (const e of [new ForgeCliEngine(), new OracleEngine()] as Engine[]) {
    if ((await e.availability()).available) return e;
  }
  return null;
}

function workspaceDirs(): string[] {
  const root = defaultWorkspaceRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => n !== "s");
}

describe.skipIf(!LIVE_CLI.has("claude"))("claude-cli live smoke: agent runtime (spends plan usage)", () => {
  const env = process.env as Record<string, string>;
  let binary: CliBinary | null = null;
  let stop: string | null = null;

  const planGate = (controller: AbortController) => (u: PlanUsage) => {
    const five = u.windows.find((w) => w.id === "five_hour")?.utilization ?? 0;
    console.log(`[plan] ${u.status}, five-hour ${Math.round(five * 100)}%`);
    if (u.status !== "allowed" || five >= 0.8) {
      stop = `plan usage ${u.status}, five-hour utilization ${five}`;
      controller.abort();
    }
  };

  const agentFor = (engine: Engine, controller: AbortController, extra: Partial<AgentOptions>, onLine?: (l: string) => void) => {
    const runtime = new CliAgentRuntime({
      binary: async (id: CliProviderId) => {
        if (id !== "claude-cli" || binary === null) throw new Error(`${id} not detected`);
        return binary;
      },
      env: () => env,
      mcpHost: createMcpHost({ shim: nodeShimCommand() }),
      ...(onLine ? { onStdoutLine: onLine } : {}),
    });
    const gateway = new LLMGateway({ profiles: [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES] });
    const agent = new Agent({
      gateway,
      engine,
      runtime,
      cliMode: "runtime",
      models: { designer: "claude-cli:haiku" },
      budgetUsd: 0.25,
      signal: controller.signal,
      hooks: { onPlanUsage: planGate(controller), onEvent: (e) => console.log(`  [${e.state}] ${e.type}: ${e.text.split("\n")[0]!.slice(0, 200)}`) },
      ...extra,
    });
    return { agent, gateway };
  };

  it("S0: detect, lockdown and auth (no model call)", async () => {
    const provider = CLI_PROVIDERS.get("claude-cli")!;
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

  it("S2: runtime BUILD — quick edit of the NEMA 17 plate through the CLI's own loop (1 invocation)", async (ctx) => {
    if (stop !== null || binary === null) return ctx.skip(`skipped: ${stop}`);
    const inner = await liveEngine();
    if (inner === null) return ctx.skip("no geometry engine (build forge-cli or install the oracle)");
    const engine = new RecordingEngine(inner);
    const before = new Set(workspaceDirs());
    const lines: string[] = [];
    const controller = new AbortController();
    const { agent, gateway } = agentFor(engine, controller, { kind: "quick_edit", cliLimits: { BUILD: { maxTurns: 8, wallMs: 180_000 } } }, (l) => lines.push(l));
    const r = await agent.run({ prompt: "Make the plate 2 mm thicker.", context: NEMA, name: "nema17_plate" });
    console.log(`[S2] ${r.status} (${r.stopReason}) ${r.message.slice(0, 200)}; ≈$${r.costUsd.toFixed(4)} notional; ${r.trace.llmCalls} turns; applies ${r.trace.applies}`);
    if (r.planUsage) console.log(`[S2] plan: ${JSON.stringify(r.planUsage.windows)}`);
    if (stop !== null) return ctx.skip(`aborted: ${stop}`);

    expect(r.stopReason).not.toBe("lockdown_violation");
    expect(r.mode).toBe("cli-runtime");
    expect(r.billing).toBe("subscription");
    expect(r.trace.applies).toBeGreaterThanOrEqual(1);
    expect(r.status === "proposed" || (r.status === "stopped" && r.verified)).toBe(true);
    expect(r.events.some((e) => /designer CLI phase \(claude-cli [\d.]+, lockdown (verified|static)\)/.test(e.text))).toBe(true);
    expect(gateway.ledger.filter((e) => e.source === "external")).toHaveLength(1);
    const init = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((o) => o["type"] === "system" && o["subtype"] === "init");
    expect((init?.["tools"] as string[]).every((t) => t.startsWith("mcp__cad__"))).toBe(true);
    // The workspace (and the socket dir) are gone.
    expect(workspaceDirs().filter((d) => !before.has(d))).toEqual([]);

    if (RECORD_DIR !== undefined) {
      mkdirSync(RECORD_DIR, { recursive: true });
      const scrub = new Scrubber([
        [defaultWorkspaceRoot(), "<root>"],
        [tmpdir(), "<tmp>"],
        [homedir(), "<home>"],
      ]);
      const out = lines.map((l) => scrub.line(l).replace(/<root>\/[0-9a-f]{16}\//g, "<root>/0000000000000000/"));
      writeFileSync(join(RECORD_DIR, "runtime-build.jsonl"), `${out.join("\n")}\n`);
      writeFileSync(join(RECORD_DIR, "runtime-build.engine.json"), `${JSON.stringify({ schema: FIXTURE_SCHEMA, task: "live-nema17-thicker", engine: [...new Set(engine.entries.map((e) => e.report.engine))].join("; "), entries: engine.entries }, null, 1)}\n`);
      writeFileSync(join(RECORD_DIR, "runtime-build.result.json"), `${JSON.stringify({ status: r.status, stopReason: r.stopReason, cadscript: r.cadscript, applies: r.trace.applies }, null, 1)}\n`);
      console.log(`[S2] recorded ${out.length} lines and ${engine.entries.length} engine reports to ${RECORD_DIR}`);
    }
  }, 240_000);

  it.skipIf(process.env["AICAD_LIVE_CLI_NUDGE"] !== "1")("S2n: a turn end without a proposal is nudged over stdin in the same process (1 invocation)", async (ctx) => {
    if (stop !== null || binary === null) return ctx.skip(`skipped: ${stop}`);
    const inner = await liveEngine();
    if (inner === null) return ctx.skip("no geometry engine");
    const engine = new RecordingEngine(inner);
    const lines: string[] = [];
    const controller = new AbortController();
    const { agent } = agentFor(engine, controller, { kind: "quick_edit", cliLimits: { BUILD: { maxTurns: 6, wallMs: 150_000 } } }, (l) => lines.push(l));
    const r = await agent.run({ prompt: "Do not change anything and do not call any tool. Reply with one short sentence that describes the plate.", context: NEMA, name: "nema17_plate" });
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const results = events.filter((o) => o["type"] === "result").length;
    console.log(`[S2n] ${r.status} (${r.stopReason}) ${r.message.slice(0, 160)}; ${results} CLI turns in one process; ≈$${r.costUsd.toFixed(4)}`);
    if (stop !== null) return ctx.skip(`aborted: ${stop}`);
    expect(r.stopReason).not.toBe("lockdown_violation");
    // At least one nudge reached the same process: a second result event (Claude re-announces init per message).
    expect(results).toBeGreaterThanOrEqual(2);
    expect(events.filter((o) => o["type"] === "system" && o["subtype"] === "init").length).toBeGreaterThanOrEqual(2);
    expect(r.cadscript).toBe(NEMA);
    if (RECORD_DIR !== undefined) {
      mkdirSync(RECORD_DIR, { recursive: true });
      const scrub = new Scrubber([
        [defaultWorkspaceRoot(), "<root>"],
        [tmpdir(), "<tmp>"],
        [homedir(), "<home>"],
      ]);
      const out = lines.map((l) => scrub.line(l).replace(/<root>\/[0-9a-f]{16}\//g, "<root>/0000000000000000/"));
      writeFileSync(join(RECORD_DIR, "runtime-nudge.jsonl"), `${out.join("\n")}\n`);
      writeFileSync(join(RECORD_DIR, "runtime-nudge.result.json"), `${JSON.stringify({ status: r.status, stopReason: r.stopReason, message: r.message, results }, null, 1)}\n`);
    }
  }, 240_000);

  it.skipIf(process.env["AICAD_LIVE_CLI_SPEC"] !== "1")("S3: runtime SPEC then BUILD, each in its own process (2 invocations)", async (ctx) => {
    if (stop !== null || binary === null) return ctx.skip(`skipped: ${stop}`);
    const engine = await liveEngine();
    if (engine === null) return ctx.skip("no geometry engine");
    const controller = new AbortController();
    const { agent } = agentFor(engine, controller, { kind: "design", cliLimits: { SPEC: { maxTurns: 6, wallMs: 150_000 }, BUILD: { maxTurns: 8, wallMs: 180_000 } } });
    const r = await agent.run({ prompt: "A square plate, 20 x 20 mm, 3 mm thick.", name: "square" });
    console.log(`[S3] ${r.status} (${r.stopReason}); spec ${r.spec ? `${r.spec.tests.length} tests` : "none"}; ≈$${r.costUsd.toFixed(4)}`);
    if (stop !== null) return ctx.skip(`aborted: ${stop}`);
    expect(r.stopReason).not.toBe("lockdown_violation");
    expect(r.trace.states).toContain("SPEC");
    expect(r.trace.costByRole.spec_writer).toBeGreaterThan(0);
  }, 420_000);
});

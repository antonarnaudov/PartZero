/**
 * Agent-runtime mode in the desktop worker (docs/CLI-PROVIDERS.md §3.3, §8.3; ADR 0014), offline: the REAL
 * `AgentRunner` with the real `loadCliRuntime` (`@aicad/agent/cli-runtime`), the real `@aicad/mcp-server` (broker and
 * the built stdio shim, loaded from the workspace as in development) and the real `ClaudeCliProvider`, driven by the
 * agent package's fake `claude` (`packages/agent/test/fake-cli/fake-claude.mjs`). That fake speaks MCP: in runtime
 * mode it launches our `cad` server from `--mcp-config`, and every scripted tool call is a real `tools/call` through
 * the shim and the broker into the orchestrator. No key, no network, no real CLI.
 *
 * This is the path the default CLI mode (`auto`) takes in development builds, so it covers what the completion-mode
 * tests in cli-providers.test.ts cannot: plan usage from runtime phases, lockdown violations inside a runtime phase,
 * Stop during a phase, and the CLI children's own environment.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentEvent } from "@aicad/app/bridge";
import { CLI_PROVIDERS, liveCliProcessGroups } from "@aicad/llm-gateway/cli";
import { describe, expect, it } from "vitest";
import { CliDetector } from "../src/agent/cli-detect.js";
import { binaryToWire, brokerSocketFits, type HostToWorker, type WorkerToHost } from "../src/agent/protocol.js";
import { AgentRunner } from "../src/agent/runner.js";
import { tempDirs } from "./temp-dirs.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const FAKE = join(repo, "packages", "agent", "test", "fake-cli", "fake-claude.mjs");
const MCP_SERVER = join(repo, "packages", "mcp-server");
const wasm = join(repo, "packages", "forge-web", "pkg", "forge_wasm_bg.wasm");
const NEMA = readFileSync(join(repo, "corpus", "makerbench", "t1-nema17-plate.cad.ts"), "utf8");
const ready =
  process.platform !== "win32" &&
  existsSync(FAKE) &&
  existsSync(join(MCP_SERVER, "dist", "stdio.js")) &&
  existsSync(join(repo, "packages", "agent", "dist", "cli-runtime.js")) &&
  existsSync(wasm);
// Short: the broker socket lives under the workspace root (macOS sun_path <= 103 bytes).
const tmp = tempDirs("rt-");

interface Msg {
  text?: string;
  calls?: Array<{ name: string; args?: Record<string, unknown> }>;
  sleepMs?: number;
}

interface Scenario {
  completion?: Record<string, unknown[]>;
  runtime?: Record<string, { turns?: Msg[][]; extraTools?: string[]; planUsage?: Record<string, unknown> }>;
}

/** The agent package's fake `claude` in `<root>/bin`, recording into `<root>/rec`. */
function fakeClaude(root: string, scenario: Scenario) {
  const binDir = join(root, "bin");
  const rec = join(root, "rec");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(rec, { recursive: true });
  const scenarioPath = join(root, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify({ ...scenario, recordDir: rec }));
  const bin = join(binDir, "claude");
  writeFileSync(bin, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(FAKE).href)}).then((m) => m.main(${JSON.stringify(scenarioPath)}));\n`);
  chmodSync(bin, 0o755);
  const jsonl = <T>(name: string): T[] =>
    existsSync(join(rec, name))
      ? readFileSync(join(rec, name), "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as T)
      : [];
  return {
    binDir,
    invocations: () => jsonl<{ pid: number; mode: "runtime" | "completion"; argv: string[]; envNames: string[]; hasTicket: boolean; cwd: string }>("invocations.jsonl"),
    calls: () => jsonl<{ phase: string; name: string; isError: boolean; text: string }>("calls.jsonl"),
    phases: () => jsonl<{ phase: string; pid: number; mcpPid: number | null; tools: string[] }>("phases.jsonl"),
  };
}

function probeEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"]) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

function runner() {
  const events: AgentEvent[] = [];
  const posts: WorkerToHost[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const listeners: Array<(e: AgentEvent) => void> = [];
  // The real optional-module loaders (no loadMcpServer / loadCliRuntime injection): the development path.
  const r = new AgentRunner({
    post: (m) => {
      posts.push(m);
      if (m.type !== "event") return;
      events.push(m.event);
      for (const l of listeners) l(m.event);
      if (m.event.type === "result" || m.event.type === "error") resolveDone();
    },
    env: probeEnv,
  });
  const waitFor = (type: AgentEvent["type"]): Promise<AgentEvent> =>
    new Promise((res) => {
      const hit = events.find((e) => e.type === type);
      if (hit) return res(hit);
      listeners.push((e) => e.type === type && res(e));
    });
  return { r, events, posts, done, waitFor };
}

async function start(root: string, binDir: string, runId: string, mode: "auto" | "runtime" = "auto"): Promise<Extract<HostToWorker, { type: "start" }>> {
  const d = new CliDetector({ providers: CLI_PROVIDERS, env: probeEnv, cliPaths: () => ({}), searchDirs: [binDir], loginShell: false });
  await d.status({ providers: ["claude-cli"] });
  const b = d.binary("claude-cli");
  if (!b) throw new Error(`fake claude not ready: ${JSON.stringify(d.statusOf("claude-cli"))}`);
  const workspaceRoot = join(root, "w");
  expect(brokerSocketFits(workspaceRoot)).toBe(true);
  return {
    type: "start",
    v: 1,
    runId,
    request: { v: 1, prompt: "Make the plate 2 mm thicker", source: NEMA, documentName: "t1-nema17-plate", selection: [] },
    config: {
      models: { designer: "claude-cli:opus", spec_writer: "claude-cli:opus", triage: "claude-cli:haiku", judge: "claude-cli:fable" },
      budgetUsd: 1,
      compatBaseUrl: null,
      transport: { kind: "live" },
      forgeBin: "/nonexistent/aicad",
      cli: {
        binaries: { "claude-cli": binaryToWire(b) },
        mode,
        workspaceRoot,
        // Development: the MCP shim runs as `<exe> <mcp-server>/dist/stdio.js` (here Node itself).
        exePath: process.execPath,
        mcpServerDir: MCP_SERVER,
        childEnv: { HTTPS_PROXY: "http://proxy.invalid:3128", NODE_OPTIONS: "--require /nonexistent/evil.js" },
      },
    },
    secrets: {},
  };
}

const TRIAGE = [{ text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit", complexity: "T1", needs_clarification: false, reason: "one dimension of the open plate changes" } }] }];
const ASK: Msg = {
  text: "The plate is extrude(outline, { distance: 5 }). Which way should the extra material go?",
  calls: [
    {
      name: "ask_user",
      args: { questions: [{ id: "q1", question: "Which way should the extra 2 mm go?", options: ["Up (+Z), keep the bottom face on the build plate", "Symmetric (1 mm each side)"], default: "Up (+Z), keep the bottom face on the build plate" }] },
    },
  ],
};
const APPLY: Msg = { text: "Distance 5 → 7 mm.", calls: [{ name: "apply_cadscript", args: { patches: [{ feature: "plate", code: "const plate = extrude(outline, { distance: 7 });" }], note: "plate 5 → 7 mm" } }] };
const PROPOSE: Msg = { calls: [{ name: "propose", args: { summary: "The NEMA 17 plate is now 7 mm thick (was 5 mm).", assumptions: ["thickened upward"], known_issues: [] } }] };

async function until(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ready)("agent runner in CLI agent-runtime mode (fake Claude Code speaking MCP, no key)", () => {
  it("auto mode runs BUILD in the CLI's own loop: real MCP tool calls, the question card, plan usage, cleanup", async () => {
    const root = tmp();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const fake = fakeClaude(root, {
      completion: { triage: TRIAGE },
      runtime: {
        build: {
          planUsage: { status: "allowed", resetsAt, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.21, resetsAt }, seven_day: { utilization: 0.06, resetsAt } } },
          turns: [[ASK, APPLY, PROPOSE, { text: "Done." }]],
        },
      },
    });
    const { r, events, posts, done, waitFor } = runner();
    r.handle(await start(root, fake.binDir, "run-rt"));
    const q = (await waitFor("question")) as Extract<AgentEvent, { type: "question" }>;
    expect(q.questions[0]).toMatchObject({ id: "q1", question: "Which way should the extra 2 mm go?" });
    r.handle({ type: "answer", v: 1, runId: "run-rt", questionId: q.questionId, answers: [""] });
    await done;

    const res = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(res, res.message).toMatchObject({ status: "proposed", stopReason: "proposed", changed: true, verified: true, billing: "subscription" });
    expect(res.proposedSource).toBe(NEMA.replace("distance: 5", "distance: 7"));

    // Triage is one completion call; BUILD is one runtime process whose tool calls went through the broker.
    const inv = fake.invocations();
    expect(inv.map((i) => i.mode)).toEqual(["completion", "runtime"]);
    const rt = inv[1]!;
    for (const f of ["-p", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) expect(rt.argv).toContain(f);
    expect(rt.argv[rt.argv.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(rt.argv[rt.argv.indexOf("--tools") + 1]).toBe("");
    expect(rt.hasTicket).toBe(true);
    expect(fake.calls().map((c) => [c.name, c.isError])).toEqual([
      ["ask_user", false],
      ["apply_cadscript", false],
      ["propose", false],
    ]);
    expect(fake.phases()[0]!.tools).toContain("apply_cadscript");
    // CLI children get the run's childEnv (proxy), but only allowlisted names; never a key.
    for (const i of inv) {
      expect(i.envNames).toContain("HTTPS_PROXY");
      expect(i.envNames).not.toContain("NODE_OPTIONS");
      expect(i.envNames.filter((k) => /API_?KEY|TOKEN|SECRET|^ANTHROPIC_/.test(k))).toEqual([]);
    }
    expect(process.env["HTTPS_PROXY"]).toBeUndefined(); // the worker's own environment is untouched

    // Plan usage reported inside the runtime phase reaches the renderer (and so the main process's cache).
    const plans = events.filter((e): e is Extract<AgentEvent, { type: "plan" }> => e.type === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ provider: "claude-cli", usage: { status: "allowed", windows: [{ id: "five_hour", utilization: 0.21 }, { id: "seven_day", utilization: 0.06 }] } });
    expect(events.some((e) => e.type === "phase" && e.phase === "BUILD")).toBe(true);
    const llm = events.filter((e): e is Extract<AgentEvent, { type: "llm" }> => e.type === "llm");
    expect(llm.every((e) => e.billing === "subscription")).toBe(true);
    expect(posts.some((m) => m.type === "cli")).toBe(false);

    // Processes gone; workspaces and socket dirs removed.
    const phase = fake.phases()[0]!;
    expect(await until(() => !alive(phase.pid) && !alive(phase.mcpPid))).toBe(true);
    expect(liveCliProcessGroups()).toEqual([]);
    const w = join(root, "w");
    expect(readdirSync(w).filter((n) => n !== "s")).toEqual([]);
    expect(existsSync(join(w, "s")) ? readdirSync(join(w, "s")) : []).toEqual([]);
  });

  it("a lockdown violation inside a runtime phase stops the run and reports the binary for blocking", async () => {
    const root = tmp();
    const fake = fakeClaude(root, { completion: { triage: TRIAGE }, runtime: { build: { extraTools: ["Bash"], turns: [[APPLY, PROPOSE]] } } });
    const { r, events, posts, done } = runner();
    const msg = await start(root, fake.binDir, "run-rt-trip");
    r.handle(msg);
    await done;
    const res = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(res).toMatchObject({ status: "failed", stopReason: "lockdown_violation", changed: false });
    const reports = posts.filter((m): m is Extract<WorkerToHost, { type: "cli" }> => m.type === "cli");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: "lockdown_violation", provider: "claude-cli", realPath: msg.config.cli!.binaries["claude-cli"]!.realPath, detail: expect.stringMatching(/Bash/) });
    expect(fake.calls()).toEqual([]); // the CLI never got to call a tool
    expect(liveCliProcessGroups()).toEqual([]);
  });

  it("Stop during a runtime phase kills the CLI and its MCP server, removes the workspace and ends the run cancelled", async () => {
    const root = tmp();
    const fake = fakeClaude(root, { completion: { triage: TRIAGE }, runtime: { build: { turns: [[{ sleepMs: 60_000 }]] } } });
    const { r, events, done } = runner();
    r.handle(await start(root, fake.binDir, "run-rt-stop", "runtime"));
    expect(await until(() => fake.phases().length === 1)).toBe(true);
    const phase = fake.phases()[0]!;
    expect(alive(phase.pid)).toBe(true);
    const t0 = Date.now();
    r.handle({ type: "stop", v: 1, runId: "run-rt-stop" });
    await done;
    expect(Date.now() - t0).toBeLessThan(15_000);
    const res = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(res).toMatchObject({ stopReason: "cancelled", changed: false });
    expect(await until(() => !alive(phase.pid) && !alive(phase.mcpPid))).toBe(true);
    expect(liveCliProcessGroups()).toEqual([]);
    const w = join(root, "w");
    expect(readdirSync(w).filter((n) => n !== "s")).toEqual([]);
    expect(existsSync(join(w, "s")) ? readdirSync(join(w, "s")) : []).toEqual([]);
  });
});

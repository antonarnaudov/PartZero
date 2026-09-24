/**
 * Live checks against the REAL Claude Code on this machine (docs/CLI-PROVIDERS.md §13.2). Never in CI: they use the
 * maintainer's login and, for the run step, the maintainer's plan.
 *
 *   AICAD_LIVE_CLI=claude pnpm --filter @aicad/desktop exec vitest run test/cli-live.test.ts
 *     S0: the desktop detector finds Claude Code, the lockdown is verified or static, and it is logged in.
 *         No model call (version, --help and `claude auth status --json` only).
 *   AICAD_LIVE_CLI=claude AICAD_LIVE_CLI_RUN=1 …
 *     + the desktop runner does "make the plate 2 mm thicker" with Claude Haiku in every role, keyless. At most 4 CLI
 *       invocations (a guard refuses a fifth), about $0.01–0.03 notional on Haiku.
 *   AICAD_LIVE_CLI=claude AICAD_LIVE_CLI_RUNTIME=1 …
 *     + the same task in agent-runtime mode (`auto`, the default in development builds): triage is one completion call,
 *       BUILD is one Claude Code process running its own loop over our CAD tools through the real MCP broker and shim.
 *       A guard stops the run after 12 model turns; about $0.02–0.06 notional on Haiku.
 *
 * The detector sees the machine's real PATH and install dirs; credentials are never read (the login probe keeps only
 * the state, the method label and the plan name).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@aicad/app/bridge";
import { CLI_PROVIDERS } from "@aicad/llm-gateway/cli";
import { describe, expect, it } from "vitest";
import { CliDetector } from "../src/agent/cli-detect.js";
import { binaryToWire, brokerSocketFits, type WorkerToHost } from "../src/agent/protocol.js";
import { AgentRunner } from "../src/agent/runner.js";
import { cliDetectEnv } from "../src/env.js";
import { tempDirs } from "./temp-dirs.js";

const LIVE_CLI = new Set((process.env["AICAD_LIVE_CLI"] ?? "").split(",").filter(Boolean));
const RUN = process.env["AICAD_LIVE_CLI_RUN"] === "1";
const RUNTIME = process.env["AICAD_LIVE_CLI_RUNTIME"] === "1";
const MCP_SERVER = fileURLToPath(new URL("../../mcp-server/", import.meta.url));
const tmp = tempDirs("aicad-cli-live-");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const wasm = join(repo, "packages", "forge-web", "pkg", "forge_wasm_bg.wasm");

describe.skipIf(!LIVE_CLI.has("claude"))("claude-cli live (desktop)", () => {
  const env = cliDetectEnv(process.env);
  const detector = new CliDetector({ providers: new Map([["claude-cli", CLI_PROVIDERS.get("claude-cli")!]]), env: () => env, cliPaths: () => ({}), loginShell: true });

  it("S0: detects Claude Code, verified lockdown, logged in (no model call)", async () => {
    const [s] = await detector.status();
    console.log(`[live] ${s!.label} ${s!.version} at ${s!.path} (${s!.pathSource}); lockdown ${s!.lockdownLevel}; auth ${s!.auth}${s!.plan ? ` (${s!.plan})` : ""}`);
    expect(s).toMatchObject({ id: "claude-cli", installed: true, support: "ready", auth: "logged_in" });
    expect(["verified", "static"]).toContain(s!.lockdownLevel);
    expect(JSON.stringify(s)).not.toMatch(/@|orgId|accountUuid/);
  });

  it.skipIf(!RUN || !existsSync(wasm))("S1: a keyless desktop run with Claude Haiku, at most 4 invocations", { timeout: 300_000 }, async () => {
    await detector.status();
    const binary = detector.binary("claude-cli");
    expect(binary).not.toBeNull();
    const events: AgentEvent[] = [];
    const posts: WorkerToHost[] = [];
    let invocations = 0;
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const runner = new AgentRunner({
      post: (m) => {
        posts.push(m);
        if (m.type !== "event") return;
        events.push(m.event);
        if (m.event.type === "llm") invocations += 1;
        // Answer after the question is registered (the event is posted before the run waits for it).
        const e = m.event;
        if (e.type === "question") setTimeout(() => runner.handle({ type: "answer", v: 1, runId: "live", questionId: e.questionId, answers: [""] }), 0);
        // The guard: a fifth model call is refused by stopping the run.
        if (m.event.type === "llm" && invocations >= 4) runner.handle({ type: "stop", v: 1, runId: "live" });
        if (m.event.type === "result" || m.event.type === "error") finish();
      },
      env: () => env,
      loadMcpServer: async () => null,
      loadCliRuntime: async () => null,
    });
    const root = tmp();
    runner.handle({
      type: "start",
      v: 1,
      runId: "live",
      request: { v: 1, prompt: "Make the plate 2 mm thicker", source: readFileSync(join(repo, "corpus", "makerbench", "t1-nema17-plate.cad.ts"), "utf8"), documentName: "t1-nema17-plate", selection: [] },
      config: {
        models: { designer: "claude-cli:haiku", spec_writer: "claude-cli:haiku", triage: "claude-cli:haiku", judge: "claude-cli:fable" },
        budgetUsd: 0.25,
        compatBaseUrl: null,
        transport: { kind: "live" },
        forgeBin: "/nonexistent/aicad",
        cli: { binaries: { "claude-cli": binaryToWire(binary!) }, mode: "completion", workspaceRoot: join(root, "cli-work"), exePath: null, mcpServerDir: null },
      },
      secrets: {},
    });
    await done;
    const last = events.at(-1)!;
    const cost = events.filter((e): e is Extract<AgentEvent, { type: "cost" }> => e.type === "cost").at(-1);
    console.log(`[live] ${invocations} invocation(s); ≈ $${cost?.spentUsd.toFixed(4) ?? "?"} notional; ${last.type === "result" ? `${last.result.status}/${last.result.stopReason}` : `${last.type}`}`);
    expect(invocations).toBeLessThanOrEqual(4);
    expect(events.some((e) => e.type === "plan")).toBe(true);
    expect(cost?.notional).toBe(true);
    expect(posts.some((m) => m.type === "cli")).toBe(false); // no lockdown violation
    expect(last.type).toBe("result");
  });

  it.skipIf(!RUNTIME || !existsSync(wasm) || !existsSync(join(MCP_SERVER, "dist", "stdio.js")))(
    "S2: agent-runtime mode (auto): BUILD in Claude Code's own loop over the CAD MCP tools, Claude Haiku",
    { timeout: 400_000 },
    async () => {
      await detector.status();
      const binary = detector.binary("claude-cli");
      expect(binary).not.toBeNull();
      const events: AgentEvent[] = [];
      const posts: WorkerToHost[] = [];
      let turns = 0;
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      const runner = new AgentRunner({
        post: (m) => {
          posts.push(m);
          if (m.type !== "event") return;
          const e = m.event;
          events.push(e);
          if (e.type === "llm") turns += 1;
          if (e.type === "question") setTimeout(() => runner.handle({ type: "answer", v: 1, runId: "live-rt", questionId: e.questionId, answers: [""] }), 0);
          if (e.type === "llm" && turns >= 12) runner.handle({ type: "stop", v: 1, runId: "live-rt" });
          if (e.type === "result" || e.type === "error") finish();
        },
        env: () => env,
        // The real loaders: @aicad/agent/cli-runtime and the workspace's @aicad/mcp-server, as in development builds.
      });
      const root = tmp();
      const workspaceRoot = join(root, "cli-work");
      expect(brokerSocketFits(workspaceRoot)).toBe(true);
      runner.handle({
        type: "start",
        v: 1,
        runId: "live-rt",
        request: { v: 1, prompt: "Make the plate 2 mm thicker", source: readFileSync(join(repo, "corpus", "makerbench", "t1-nema17-plate.cad.ts"), "utf8"), documentName: "t1-nema17-plate", selection: [] },
        config: {
          models: { designer: "claude-cli:haiku", spec_writer: "claude-cli:haiku", triage: "claude-cli:haiku", judge: "claude-cli:fable" },
          budgetUsd: 0.25,
          compatBaseUrl: null,
          transport: { kind: "live" },
          forgeBin: "/nonexistent/aicad",
          cli: { binaries: { "claude-cli": binaryToWire(binary!) }, mode: "auto", workspaceRoot, exePath: process.execPath, mcpServerDir: MCP_SERVER },
        },
        secrets: {},
      });
      await done;
      const last = events.at(-1)!;
      const llm = events.filter((e): e is Extract<AgentEvent, { type: "llm" }> => e.type === "llm");
      const tools = events.filter((e): e is Extract<AgentEvent, { type: "tool" }> => e.type === "tool").map((e) => `${e.name}:${e.ok ? "ok" : "err"}`);
      const cost = events.filter((e): e is Extract<AgentEvent, { type: "cost" }> => e.type === "cost").at(-1);
      console.log(`[live] runtime: ${turns} turn(s); tools ${tools.join(" ")}; ≈ $${cost?.spentUsd.toFixed(4) ?? "?"} notional; ${last.type === "result" ? `${last.result.status}/${last.result.stopReason}: ${last.result.message.slice(0, 200)}` : `${last.type}: ${(last as { message?: string }).message ?? ""}`}`);
      for (const e of events) if (e.type === "note") console.log(`[live] note: ${e.text.slice(0, 200)}`);
      expect(llm.some((e) => /cli-runtime/.test(e.summary))).toBe(true); // BUILD really ran in the CLI's own loop
      expect(tools.some((t) => t.startsWith("apply_cadscript"))).toBe(true); // through the MCP broker into the orchestrator
      expect(events.some((e) => e.type === "plan")).toBe(true);
      expect(posts.some((m) => m.type === "cli")).toBe(false); // no lockdown violation
      expect(last.type).toBe("result");
      expect(readdirSync(workspaceRoot).filter((n) => n !== "s")).toEqual([]);
    },
  );
});

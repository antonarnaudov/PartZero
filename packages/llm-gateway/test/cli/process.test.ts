import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliEnvForBinary } from "../../src/cli/base.js";
import type { CliEvent } from "../../src/cli/events.js";
import type { CliExit, CliInvocation, CliLimits, CliRun } from "../../src/cli/provider.js";
import { CLI_PROVIDERS } from "../../src/cli/registry.js";
import { createCliWorkspace, type CliWorkspace } from "../../src/cli/workspace.js";
import { binaryFor, fixturePath, isAlive, makeFakeCli, removeDir, tempDir, type FakeScenario } from "./helpers.js";

const claude = CLI_PROVIDERS.get("claude-cli")!;

let dir: string | null = null;
let ws: CliWorkspace | null = null;
afterEach(async () => {
  await ws?.dispose();
  ws = null;
  if (dir !== null) removeDir(dir);
  dir = null;
});

async function start(scenario: FakeScenario, limits: Partial<CliLimits> = {}, over: Partial<CliInvocation> = {}, signal?: AbortSignal): Promise<{ run: CliRun; inv: CliInvocation }> {
  dir = tempDir();
  const path = makeFakeCli(dir, "claude", { help: fixturePath("help/claude-2.1.260.txt"), ...scenario });
  const binary = binaryFor("claude-cli", path, "2.1.260", ["claude-2.1.260.txt"]);
  ws = await createCliWorkspace({ root: join(dir, "aicad-cli"), runId: "t" });
  const parent = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir, ANTHROPIC_API_KEY: "sk-ant-test-must-not-leak-0000", CLAUDECODE: "1" };
  const inv: CliInvocation = {
    runId: "3b241101-e2bb-4255-8caf-4136c566a962",
    mode: "completion",
    binary,
    workspace: ws,
    model: "haiku",
    effort: null,
    systemPrompt: "system",
    prompt: "PROMPT-TEXT",
    images: [],
    structured: null,
    mcp: null,
    resume: null,
    limits: { maxTurns: 3, wallMs: 20_000, stallMs: 10_000, ...limits },
    env: cliEnvForBinary(binary, parent, ws.tmp),
    ...over,
  };
  return { run: claude.run(inv, signal === undefined ? {} : { signal }), inv };
}

async function drain(run: CliRun): Promise<{ events: CliEvent[]; exit: CliExit }> {
  const events: CliEvent[] = [];
  for await (const e of run.events) events.push(e);
  return { events, exit: await run.done };
}

describe("CliRun: spawn, materialized files, environment", () => {
  it("replays a recorded run; files are written 0400 in the empty workspace; no credential reaches the child", async () => {
    const record = join(tempDir("aicad-rec-"), "rec.json");
    const { run } = await start({ fixture: fixturePath("claude/completion-plain.jsonl"), record });
    const { events, exit } = await drain(run);
    expect(exit).toMatchObject({ code: 0, reason: "exited", failure: null });
    expect(exit.result).toMatchObject({ ok: true, text: "pong" });
    expect(events.map((e) => e.type)).toContain("init");
    const rec = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; env: Record<string, string>; cwd: string; stdin: string; files: Array<{ path: string; mode: number }> };
    expect(rec.stdin).toBe("PROMPT-TEXT");
    expect(rec.argv.join(" ")).not.toContain("PROMPT-TEXT");
    expect(rec.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(rec.env["CLAUDECODE"]).toBeUndefined();
    expect(rec.env["TMPDIR"]).toBe(ws!.tmp);
    expect(rec.env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"]).toBe("1");
    expect(rec.cwd).toBe(ws!.dir);
    expect(rec.files.map((f) => [f.path, f.mode]).sort()).toEqual([
      ["claude-settings.json", 0o400],
      ["mcp.json", 0o400],
      ["system.md", 0o400],
    ]);
    removeDir(join(record, ".."));
  });

  it("a tripwire (init lists Bash) kills the run as lockdown_violation", async () => {
    dir = tempDir();
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, `${JSON.stringify({ type: "system", subtype: "init", session_id: "s", tools: ["Bash", "Read"], mcp_servers: [], model: "m" })}\n`);
    const d = dir;
    dir = null;
    const { run } = await start({ fixture: bad, delayMs: 5_000 });
    const { exit, events } = await drain(run);
    removeDir(d);
    expect(exit.failure).toMatchObject({ code: "lockdown_violation" });
    expect(exit.failure?.message).toMatch(/Bash/);
    expect(exit.reason).toBe("killed");
    expect(events.some((e) => e.type === "init")).toBe(false);
  });

  it("maps the recorded logged-out run and unknown options", async () => {
    const out = await start({ fixture: fixturePath("claude/not-logged-in.jsonl"), exitCode: 1 });
    expect((await drain(out.run)).exit.failure).toMatchObject({ code: "not_logged_in" });
    await ws?.dispose();
    ws = null;
    removeDir(dir!);
    const unknown = await start({ exitCode: 1, stderr: "error: unknown option '--max-turns'\n" });
    expect((await drain(unknown.run)).exit.failure).toMatchObject({ code: "unsupported" });
  });
});

describe("CliRun: timers, output limits and process-group kill (§5.7, §5.8)", () => {
  it("stall timeout: no output for stallMs -> stalled, group killed", async () => {
    const { run } = await start({ mode: "stall" }, { stallMs: 300 });
    const { exit } = await drain(run);
    expect(exit).toMatchObject({ reason: "stalled", failure: { code: "stalled" } });
    if (run.pid !== null) expect(isAlive(run.pid)).toBe(false);
  });

  it("wall-clock timeout while output keeps flowing -> timeout; extendWall adds time", async () => {
    const t0 = Date.now();
    const { run } = await start({ mode: "hang" }, { wallMs: 400, stallMs: 5_000 });
    run.extendWall?.(300);
    const { exit } = await drain(run);
    expect(exit).toMatchObject({ reason: "timeout", failure: { code: "timeout" } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(650);
  });

  it("start timeout: nothing on stdout -> timeout", async () => {
    const { run } = await start({ mode: "silent" }, { wallMs: 300, stallMs: 5_000 });
    const { exit } = await drain(run);
    expect(exit.failure?.code).toBe("timeout");
    expect(exit.failure?.message).toMatch(/no output/);
  });

  it("lines over 1 MiB are dropped and counted -> bad_output", async () => {
    const { run } = await start({ mode: "huge" });
    expect((await drain(run)).exit.failure).toMatchObject({ code: "bad_output", message: expect.stringMatching(/lines exceeded/) });
  });

  it("more than 100 non-JSON lines -> bad_output", async () => {
    const { run } = await start({ mode: "nonjson" });
    expect((await drain(run)).exit.failure).toMatchObject({ code: "bad_output", message: expect.stringMatching(/non-JSON/) });
  });

  it("cancel kills the whole group, including a grandchild", async () => {
    const pidFile = join(tempDir("aicad-pid-"), "pid");
    const { run } = await start({ mode: "grandchild", pidFile });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(grandchild)).toBe(true);
    const exit = await claude.cancel(run, "user");
    expect(exit).toMatchObject({ reason: "cancelled", failure: { code: "cancelled" } });
    for (let i = 0; i < 50 && isAlive(grandchild); i++) await new Promise((r) => setTimeout(r, 20));
    expect(isAlive(grandchild)).toBe(false);
    removeDir(join(pidFile, ".."));
  });

  it("a child that ignores SIGTERM is SIGKILLed after the grace period", async () => {
    const { run } = await start({ mode: "ignore-term" });
    for await (const e of run.events) if (e.type === "init") break;
    const t0 = Date.now();
    const exit = await claude.cancel(run, "timeout");
    expect(exit.reason).toBe("timeout");
    expect(exit.signal).toBe("SIGKILL");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_900);
  }, 15_000);

  it("an AbortSignal cancels the run", async () => {
    const ctl = new AbortController();
    const { run } = await start({ mode: "stall" }, { stallMs: 10_000 }, {}, ctl.signal);
    setTimeout(() => ctl.abort(), 100);
    expect((await drain(run)).exit).toMatchObject({ reason: "cancelled", failure: { code: "cancelled" } });
  });

  it("send() writes a stream-json user message (Claude runtime) and closeInput() ends the process", async () => {
    const record = join(tempDir("aicad-rec-"), "rec.json");
    const { run } = await start({ fixture: fixturePath("claude/completion-plain.jsonl"), record }, {}, { mode: "runtime" });
    run.send({ text: "continue please" });
    run.closeInput();
    const { exit } = await drain(run);
    expect(exit.failure).toBeNull();
    const stdin = (JSON.parse(readFileSync(record, "utf8")) as { stdin: string }).stdin.trim().split("\n").map((l) => JSON.parse(l) as { message: { content: Array<{ text: string }> } });
    expect(stdin.map((m) => m.message.content.at(-1)?.text)).toEqual(["PROMPT-TEXT", "continue please"]);
    removeDir(join(record, ".."));
  });
});

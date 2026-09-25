/**
 * CLI agent-runtime mode end to end, keyless and offline (docs/CLI-PROVIDERS.md §3.3, ADR 0014): Electron + the agent
 * utility process + `@aicad/agent/cli-runtime` + the CAD MCP server (broker in the worker, the shim launched by the CLI
 * as `ELECTRON_RUN_AS_NODE=1 <app> stdio.js`) + a FAKE `claude` that speaks MCP (the agent package's
 * `test/fake-cli/fake-claude.mjs`). No API key, no network, no real CLI and no login are needed.
 *
 * The profile stores `cliMode: "runtime"` (an isolated test profile runs `auto` as single calls unless it opts in:
 * env.ts `cliAutoMode`), and its data folder is deliberately long: the broker socket must still fit (setup.ts picks a
 * shorter private root).
 *
 * - A run whose BUILD phase is Claude Code's own loop: the question card comes from an MCP `ask_user` call, the
 *   proposal from MCP `apply_cadscript` + `propose`, the plan usage from the runtime phase's rate-limit event.
 * - A lockdown violation inside a runtime phase stops the run and blocks that binary, across an app restart, until
 *   Re-check passes.
 * - A used-up plan (`test/fixtures/fake-claude-quota.mjs`: the recorded shape of a rejected rate-limit event) stops the
 *   run with "plan usage limit reached" and the reset time.
 *
 * `AICAD_APP_DIST` passes through to the app (another web build, e.g. to check renderer changes without replacing
 * the workspace's `packages/app/dist/web`).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(desktopRoot, "..", "..");
const FAKE = join(repo, "packages", "agent", "test", "fake-cli", "fake-claude.mjs");
const QUOTA_FAKE = join(desktopRoot, "test", "fixtures", "fake-claude-quota.mjs");
const HELP = join(desktopRoot, "e2e", "fixtures", "fake-cli", "claude-2.1.260-help.txt");
const artifacts = join(desktopRoot, "test-results");

interface Summary {
  bbox: { min: number[]; max: number[] } | null;
}

interface AgentSummary {
  activeRunId: string | null;
  lastRun: { status: string; phases: string[]; result: { status: string; stopReason: string; changed: boolean } | null; error: string | null } | null;
}

interface AW {
  __aicad: {
    execute(cmd: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
    idle(): Promise<Summary>;
    agent(): AgentSummary;
  };
}

function keylessEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /(API_?KEY|TOKEN|SECRET)/i.test(k) || /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|CLAUDE_CODE|CODEX|CURSOR)_/.test(k) || k.startsWith("AICAD_")) continue;
    env[k] = v;
  }
  const appDist = process.env["AICAD_APP_DIST"];
  return { ...env, AICAD_AGENT_DOTENV: "off", AICAD_SKIP_CLOSE_PROMPT: "1", ...(appDist ? { AICAD_APP_DIST: appDist } : {}), ...extra };
}

const TRIAGE = [{ text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit", complexity: "T1", needs_clarification: false, reason: "one dimension of the open plate changes" } }] }];
const QUESTION = "Which way should the extra 2 mm go?";
const BUILD_TURN = [
  {
    text: "The plate is extrude(outline, { distance: 5 }). I need the direction of the extra material.",
    calls: [{ name: "ask_user", args: { questions: [{ id: "q1", question: QUESTION, options: ["Up (+Z), keep the bottom face on the build plate", "Symmetric (1 mm each side)"], default: "Up (+Z), keep the bottom face on the build plate" }] } }],
  },
  { text: "Distance 5 → 7 mm.", calls: [{ name: "apply_cadscript", args: { patches: [{ feature: "plate", code: "const plate = extrude(outline, { distance: 7 });" }], note: "plate 5 → 7 mm" } }] },
  { calls: [{ name: "propose", args: { summary: "The NEMA 17 plate is now 7 mm thick (was 5 mm); the extra 2 mm goes up.", assumptions: ["thickened upward: bottom face stays at Z = 0"], known_issues: [] } }] },
  { text: "Done." },
];

let root: string;
let userData: string;
let binDir: string;
let rec: string;
let scenarioPath: string;
let app: ElectronApplication;
let page: Page;
const pageErrors: string[] = [];

function writeScenario(runtime: Record<string, unknown>): void {
  writeFileSync(scenarioPath, JSON.stringify({ completion: { triage: TRIAGE }, runtime, recordDir: rec }));
}

function jsonl<T>(name: string): T[] {
  const f = join(rec, name);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: [appDir, "--use-mock-keychain"], env: keylessEnv({ AICAD_USER_DATA_DIR: userData, AICAD_CLI_DIRS: binDir }) });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 }));
  await expect(page.getByTestId("app-shell")).toBeVisible();
  // The runtime plumbing is surface-independent; the fake CLI scripts the CadScript designer, so the proposal path runs here.
  await page.evaluate(() => (window as unknown as AW).__aicad.execute({ id: "agent.setSurface", args: { surface: "code" } }));
}

test.skip(process.platform === "win32", "the fake CLI is a POSIX script");
test.skip(!existsSync(FAKE) || !existsSync(join(repo, "packages", "mcp-server", "dist", "stdio.js")), "needs the agent's fake CLI and a built @aicad/mcp-server");

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "aicad-e2e-runtime-"));
  binDir = join(root, "fake", "bin");
  rec = join(root, "fake", "rec");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(rec, { recursive: true });
  scenarioPath = join(root, "fake", "scenario.json");
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  writeScenario({
    build: {
      planUsage: { status: "allowed", resetsAt, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.21, resetsAt }, seven_day: { utilization: 0.06, resetsAt } } },
      turns: [BUILD_TURN],
    },
  });
  writeFileSync(join(binDir, "claude"), `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(FAKE).href)}).then((m) => m.main(${JSON.stringify(scenarioPath)}));\n`);
  chmodSync(join(binDir, "claude"), 0o755);
  // A long data folder: <userData>/cli-work/s/<8 hex>/b.sock would not fit macOS's 103-byte socket path limit.
  userData = join(root, "user-data-with-a-long-folder-name");
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, "agent-settings.json"), JSON.stringify({ v: 1, models: {}, budgetUsd: 1, compatBaseUrl: null, ollamaBaseUrl: "http://127.0.0.1:9", cliMode: "runtime" }));
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const execute = (cmd: unknown) => page.evaluate((c) => (window as unknown as AW).__aicad.execute(c), cmd);
const summary = (): Promise<Summary> => page.evaluate(() => (window as unknown as AW).__aicad.idle());
const agent = (): Promise<AgentSummary> => page.evaluate(() => (window as unknown as AW).__aicad.agent());

test("runs BUILD inside Claude Code's own agent loop (runtime mode, MCP tools) with no API key", async () => {
  expect((await execute({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } })).ok).toBe(true);
  expect((await summary()).bbox?.max[2]).toBeCloseTo(5, 3);
  await page.getByLabel("Message").fill("Make the plate 2 mm thicker");
  await page.getByLabel("Message").press("Enter");

  const card = page.getByTestId("agent-run").last();
  const question = card.getByTestId("agent-question");
  // The question reached the app through the CLI's MCP `ask_user` call (the broker waits for the answer).
  await expect(question).toBeVisible({ timeout: 60_000 });
  await expect(question).toContainText(QUESTION);
  await question.getByTestId("agent-answer").click();

  await expect(card.getByTestId("agent-headline")).toHaveText("Proposal ready", { timeout: 60_000 });
  await expect(page.locator('[data-testid="proposal-view"] [data-change="plate/plate"]')).toContainText("distance 5 → 7 mm");
  // Plan usage reported inside the runtime phase.
  await expect(card.getByTestId("agent-plan-usage")).toContainText("5-hour 21 %");
  await expect(card.getByTestId("agent-cost")).toHaveAttribute("data-notional", "yes");
  await expect(card).not.toContainText("socket");
  await page.screenshot({ path: join(artifacts, "runtime-run.png") });
  const a = await agent();
  expect(a.lastRun?.result).toMatchObject({ status: "proposed", stopReason: "proposed", changed: true });
  expect(a.lastRun?.phases).toContain("BUILD");

  await page.getByTestId("proposal-view").getByTestId("proposal-accept").click();
  await expect(card.getByTestId("agent-resolution")).toContainText("Applied");
  expect((await summary()).bbox?.max[2]).toBeCloseTo(7, 3);

  // Triage was one completion call; BUILD one runtime process whose tools were real MCP calls into the app.
  const inv = jsonl<{ mode: string; argv: string[]; cwd: string; envNames: string[]; hasTicket: boolean }>("invocations.jsonl");
  expect(inv.map((i) => i.mode)).toEqual(["completion", "runtime"]);
  expect(inv[1]!.hasTicket).toBe(true);
  expect(inv[1]!.argv).toEqual(expect.arrayContaining(["-p", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]));
  expect(jsonl<{ name: string; isError: boolean }>("calls.jsonl").map((c) => [c.name, c.isError])).toEqual([
    ["ask_user", false],
    ["apply_cadscript", false],
    ["propose", false],
  ]);
  for (const i of inv) {
    expect(i.envNames.filter((k) => /API_?KEY|TOKEN|SECRET|^ANTHROPIC_|^OPENAI_|^ELECTRON_RUN_AS_NODE$|^NODE_OPTIONS$/.test(k))).toEqual([]);
    // The long data folder did not hold the workspaces: a shorter private root did (the socket fits).
    expect(realpathSync(dirname(dirname(i.cwd))).startsWith(realpathSync(userData))).toBe(false);
  }
  expect(pageErrors).toEqual([]);
});

test("a lockdown violation in a runtime phase blocks Claude Code, across a restart, until Re-check passes", async () => {
  // The next BUILD process reports a built-in tool (Bash) in its init tool list.
  writeScenario({ build: { extraTools: ["Bash"], turns: [BUILD_TURN.slice(1)] } });
  await page.getByLabel("Message").fill("Make it 1 mm thinner");
  await page.getByLabel("Message").press("Enter");
  const card = page.getByTestId("agent-run").last();
  await expect(card.getByTestId("agent-headline")).toHaveText("Stopped: the CLI broke its lockdown", { timeout: 60_000 });
  expect((await agent()).lastRun?.result).toMatchObject({ stopReason: "lockdown_violation", changed: false });
  expect((await summary()).bbox?.max[2]).toBeCloseTo(7, 3); // the document is unchanged

  const claude = (): ReturnType<Page["locator"]> => page.locator('[data-testid="settings-cli"][data-provider="claude-cli"]');
  expect((await execute({ id: "settings.open" })).ok).toBe(true);
  await expect(claude()).toHaveAttribute("data-support", "blocked");
  await expect(claude()).toContainText("lockdown violation");
  await page.keyboard.press("Escape");

  // Restart: the block was saved with the settings, so the binary is still refused.
  await app.close();
  await launch();
  expect((await execute({ id: "settings.open" })).ok).toBe(true);
  await expect(claude()).toHaveAttribute("data-support", "blocked");
  await page.keyboard.press("Escape");
  await page.getByLabel("Message").fill("Make it 1 mm thinner");
  await page.getByLabel("Message").press("Enter");
  await expect(page.locator(".msg-system.msg-error").last()).toContainText("Claude Code is blocked");
  const before = jsonl("invocations.jsonl").length;

  // Re-check (detection only, no model call) passes and lifts the block.
  expect((await execute({ id: "settings.open" })).ok).toBe(true);
  await claude().getByRole("button", { name: "Re-check" }).click();
  await expect(claude()).toHaveAttribute("data-support", "ready");
  await page.keyboard.press("Escape");
  expect(jsonl("invocations.jsonl").length).toBe(before);
  const settings = JSON.parse(readFileSync(join(userData, "agent-settings.json"), "utf8")) as { cliBlocks: unknown[] };
  expect(settings.cliBlocks).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("a used-up plan stops the run with the reset time", async () => {
  // Claude Code "updates itself" into one whose plan is exhausted (a changed binary is detected again).
  const resetsAt = Math.floor(Date.now() / 1000) + 7200;
  // Single calls: the quota fake answers completion calls only. (Triage falls back to its heuristic when its call
  // fails; the designer's call then stops the run.)
  expect((await execute({ id: "settings.setCliMode", args: { mode: "completion" } })).ok).toBe(true);
  writeFileSync(join(binDir, "claude"), `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(QUOTA_FAKE).href)}).then((m) => m.main(${JSON.stringify({ help: HELP, resetsAt })}));\n`);
  await page.getByLabel("Message").fill("Make it 1 mm thinner");
  await page.getByLabel("Message").press("Enter");
  const card = page.getByTestId("agent-run").last();
  await expect(card.getByTestId("agent-headline")).toHaveText("Stopped: plan usage limit reached", { timeout: 60_000 });
  await expect(card.getByTestId("agent-quota")).toContainText("Your plan's usage limit is reached. It resets");
  await expect(card.getByTestId("agent-plan-usage")).toContainText("limit reached");
  await expect(card.getByTestId("agent-result")).toContainText(new Date(resetsAt * 1000).toISOString());
  await page.screenshot({ path: join(artifacts, "runtime-quota.png") });
  expect((await agent()).lastRun?.result).toMatchObject({ status: "failed", stopReason: "model_error", changed: false });
  // Settings warns about the limit from the cached plan report.
  expect((await execute({ id: "settings.open" })).ok).toBe(true);
  await expect(page.getByTestId("settings-dialog")).toContainText("the plan's usage limit was reached at the last run");
  await page.keyboard.press("Escape");
  expect(pageErrors).toEqual([]);
});

/**
 * CLI agents, local models and optional keys in the desktop app (ADR 0014, docs/CLI-PROVIDERS.md §11), offline:
 * a FAKE `claude` (e2e/fake-cli.ts) stands in for Claude Code 2.1.260, so no test runs a real CLI, needs a login or
 * a key, or calls a model. The real `ClaudeCliProvider` (detection, lockdown, login probe, argv, stream parser,
 * tripwires) and the real gateway transport run against it.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, CliProviderStatus, LocalProviderStatus } from "@aicad/app/bridge";
import { BUILTIN_CLI_PROFILES, type CliProvider } from "@aicad/llm-gateway";
import { CLI_PROVIDERS, type OllamaStatus } from "@aicad/llm-gateway/cli";
import { describe, expect, it } from "vitest";
import { FAKE_CLAUDE_HELP, makeFakeClaude } from "../e2e/fake-cli.js";
import { CliDetector, cliPathProblem, MAX_CLI_BLOCKS, planResetAt, planUsageView } from "../src/agent/cli-detect.js";
import { AgentHost, type WorkerHandle } from "../src/agent/host.js";
import { KeyResolver, KeyStore, type Cipher } from "../src/agent/keys.js";
import { LocalModels, rebaseLocalProfile } from "../src/agent/local-detect.js";
import { binaryFromWire, binaryToWire, brokerSocketFits, parseProbeProvidersRequest, parseSettingsUpdate, parseWorkerMessage, type HostToWorker, type WorkerToHost } from "../src/agent/protocol.js";
import { AgentRunner, cliChildEnv, loadCliRuntime, loadMcpServer } from "../src/agent/runner.js";
import { autoDefaults, buildSettingsView, profileAvailability, profileRegistry, readinessFrom, SettingsStore } from "../src/agent/settings.js";
import { cliWorkspaceRoot, profileWorkspaceDir, setupAgent, type AgentSetupOptions } from "../src/agent/setup.js";
import { defaultWorkspaceRoot, liveCliProcessGroups, setDefaultWorkspaceRoot, unsafeAncestor } from "@aicad/llm-gateway/cli";
import { agentWorkerEnv, cliChildHostEnv } from "../src/env.js";
import { tempDirs } from "./temp-dirs.js";

const tmp = tempDirs("aicad-cli-test-");
const posix = process.platform !== "win32";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const NEMA = readFileSync(join(repo, "corpus", "makerbench", "t1-nema17-plate.cad.ts"), "utf8");
const wasm = join(repo, "packages", "forge-web", "pkg", "forge_wasm_bg.wasm");
const START = { v: 1, prompt: "Make the plate 2 mm thicker", source: "part('p');", documentName: "plate", selection: [] };

function cipher(): Cipher {
  return { isEncryptionAvailable: () => true, backend: () => "test", encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
}

/** A minimal env for probes and CLI children: PATH (for `node`), HOME, USER. Never a key. */
function probeEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"]) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

/** A detector that only ever sees the fake's directory (like `AICAD_CLI_DIRS` in the e2e), counting probes. */
function detector(binDir: string, options: { cliPaths?: Record<string, string> } = {}) {
  const counts = { detect: 0, auth: 0 };
  const providers = new Map<string, CliProvider>();
  for (const [id, p] of CLI_PROVIDERS) {
    const wrapped = Object.create(p) as CliProvider;
    wrapped.detect = (o) => (counts.detect++, p.detect(o));
    wrapped.authStatus = (b, e) => (counts.auth++, p.authStatus(b, e));
    providers.set(id, wrapped);
  }
  const d = new CliDetector({ providers: providers as never, env: probeEnv, cliPaths: () => options.cliPaths ?? {}, searchDirs: [binDir], loginShell: false });
  return { d, counts };
}

const status = (list: CliProviderStatus[], id: string): CliProviderStatus => list.find((s) => s.id === id)!;
/** macOS temp dirs live behind a symlink (/var → /private/var): compare paths without it. */
const unprivate = (p: string): string => p.replace(/^\/private(?=\/(var|tmp)\/)/, "");

describe.skipIf(!posix)("CLI detection (main process), with a fake Claude Code", () => {
  it("detects the fake as Claude Code 2.1.260: verified lockdown, logged in with a Max plan, never showing the account", async () => {
    const fake = makeFakeClaude(tmp());
    const { d } = detector(fake.binDir);
    const list = await d.status();
    const claude = status(list, "claude-cli");
    expect(claude).toMatchObject({
      label: "Claude Code",
      installed: true,
      path: fake.bin,
      pathSource: "path", // AICAD_CLI_DIRS stands in for PATH
      version: "2.1.260",
      support: "ready",
      lockdownLevel: "verified",
      auth: "logged_in",
      plan: "max",
      billing: "subscription",
      loginHint: "Run `claude auth login` in a terminal",
      modes: ["completion", "runtime"],
    });
    expect(claude.residualRisks.length).toBeGreaterThan(2);
    // The login probe's account fields are dropped unseen.
    expect(JSON.stringify(list)).not.toMatch(/fixture@example\.invalid|org-fixture/);
    // Only the fake's directory is searched: every other CLI is "not installed", and nothing else was run.
    for (const id of ["gemini-cli", "codex-cli", "opencode", "cursor-agent"]) expect(status(list, id)).toMatchObject({ support: "not_installed", installed: false });
    expect(d.binaryRef("claude-cli")).toMatchObject({ provider: "claude-cli", path: fake.bin, realPath: fake.realBin, version: "2.1.260" });
    expect(fake.calls()).toEqual([]); // no model call during detection
  });

  it("caches detection and logins, re-detects a binary that changed on disk, and Re-check forces both", async () => {
    const fake = makeFakeClaude(tmp());
    const { d, counts } = detector(fake.binDir);
    await d.status({ providers: ["claude-cli"] });
    await d.status({ providers: ["claude-cli"] });
    expect(counts).toEqual({ detect: 1, auth: 1 });
    // A CLI that updated itself (same path, new mtime) is detected again.
    const later = new Date(Date.now() + 5_000);
    utimesSync(fake.bin, later, later);
    await d.status({ providers: ["claude-cli"] });
    expect(counts).toEqual({ detect: 2, auth: 2 });
    await d.status({ providers: ["claude-cli"], force: true });
    expect(counts).toEqual({ detect: 3, auth: 3 });
  });

  it("reports a logged-out CLI, an old version, and a tripwire block that lasts until Re-check", async () => {
    const fake = makeFakeClaude(tmp(), { loggedIn: false });
    const { d } = detector(fake.binDir);
    expect(status(await d.status(), "claude-cli")).toMatchObject({ support: "ready", auth: "logged_out", plan: null });
    fake.setLoggedIn(true);
    expect(status(await d.status({ force: true }), "claude-cli")).toMatchObject({ auth: "logged_in" });

    d.markBlocked("claude-cli", fake.realBin, "unexpected_tool: Bash");
    expect(status(d.view(), "claude-cli")).toMatchObject({ support: "blocked", modes: [], supportDetail: expect.stringMatching(/lockdown violation.*Re-check/) });
    expect(d.binary("claude-cli")).toBeNull();
    expect(status(await d.status(), "claude-cli").support).toBe("blocked"); // a cached refresh keeps the block
    expect(status(await d.status({ force: true }), "claude-cli").support).toBe("ready"); // Re-check lifts it

    const old = makeFakeClaude(tmp(), { version: "2.1.100 (Claude Code)" });
    const o = detector(old.binDir).d;
    expect(status(await o.status(), "claude-cli")).toMatchObject({ support: "unsupported_version", supportDetail: "needs Claude Code >= 2.1.260, found 2.1.100", modes: [] });
    expect(o.binary("claude-cli")).toBeNull();
  });

  it("uses a Settings path override and validates it", async () => {
    const root = tmp();
    const fake = makeFakeClaude(root);
    // The search is restricted to `root` (as AICAD_CLI_DIRS does); the override inside it is used.
    const { d } = detector(root, { cliPaths: { "claude-cli": fake.bin } });
    expect(status(await d.status(), "claude-cli")).toMatchObject({ support: "ready", pathSource: "settings", path: fake.bin });
    expect(cliPathProblem(fake.bin, ["claude"])).toBeNull();
    expect(cliPathProblem("relative/claude", ["claude"])).toMatch(/absolute/);
    expect(cliPathProblem(join(fake.binDir, "gemini"), ["claude"])).toMatch(/must point to claude/);
    expect(cliPathProblem(join(tmp(), "claude"), ["claude"])).toBe("does not exist");
  });

  it("a restricted search (AICAD_CLI_DIRS, isolated test profiles) never uses a Settings path outside it", async () => {
    const fake = makeFakeClaude(tmp());
    // A stored or seeded override pointing at a CLI outside the search dirs (e.g. the user's real ~/.local/bin/claude).
    const outside = detector(tmp(), { cliPaths: { "claude-cli": fake.bin } });
    const s1 = status(await outside.d.status(), "claude-cli");
    expect(s1).toMatchObject({ support: "not_installed", installed: false, path: null, supportDetail: expect.stringMatching(/outside AICAD_CLI_DIRS/) });
    expect(outside.counts.detect).toBe(0); // the binary was never even run for --version
    // An isolated profile without AICAD_CLI_DIRS searches nothing, so no override is used at all.
    const isolated = new CliDetector({ providers: CLI_PROVIDERS, env: probeEnv, cliPaths: () => ({ "claude-cli": fake.bin }), searchDirs: [], loginShell: false });
    expect(status(await isolated.status({ providers: ["claude-cli"] }), "claude-cli")).toMatchObject({ support: "not_installed", supportDetail: expect.stringMatching(/isolated test profile/) });
    expect(fake.calls()).toEqual([]);
    // A stored path is re-validated before use: another program's name, or a file that is not executable.
    const other = join(tmp(), "claude");
    writeFileSync(other, "#!/bin/sh\n");
    chmodSync(other, 0o644);
    const bad = new CliDetector({ providers: CLI_PROVIDERS, env: probeEnv, cliPaths: () => ({ "claude-cli": other }), searchDirs: null, loginShell: false });
    expect(status(await bad.status({ providers: ["claude-cli"] }), "claude-cli")).toMatchObject({ support: "not_installed", supportDetail: expect.stringMatching(/is not an executable file/) });
  });

  it("a lockdown block survives a restart and is lifted only by a passing Re-check or a changed binary", async () => {
    const root = tmp();
    const fake = makeFakeClaude(root);
    const settings = new SettingsStore(join(root, "agent-settings.json"));
    const make = () =>
      new CliDetector({ providers: CLI_PROVIDERS, env: probeEnv, cliPaths: () => ({}), searchDirs: [fake.binDir], loginShell: false, blocks: { load: () => settings.get().cliBlocks, save: (b) => settings.setCliBlocks(b) } });
    const d1 = make();
    await d1.status({ providers: ["claude-cli"] });
    d1.markBlocked("claude-cli", fake.realBin, "unexpected_tool: Bash");
    expect(new SettingsStore(settings.file).get().cliBlocks).toEqual([expect.objectContaining({ provider: "claude-cli", realPath: fake.realBin, reason: "unexpected_tool: Bash" })]);

    // "Restart": a new detector over the same settings file still refuses the binary, cached refresh or not.
    const d2 = make();
    expect(status(await d2.status({ providers: ["claude-cli"] }), "claude-cli")).toMatchObject({ support: "blocked", supportDetail: expect.stringMatching(/lockdown violation/) });
    expect(d2.binary("claude-cli")).toBeNull();
    expect(status(await d2.status({ providers: ["claude-cli"] }), "claude-cli").support).toBe("blocked");
    // Re-check that passes lifts it, and the lift is saved.
    expect(status(await d2.status({ providers: ["claude-cli"], force: true }), "claude-cli").support).toBe("ready");
    expect(new SettingsStore(settings.file).get().cliBlocks).toEqual([]);

    // A binary that changes on disk (the CLI updated itself) is a new binary: the block does not carry over.
    d2.markBlocked("claude-cli", fake.realBin, "unexpected_tool: Bash");
    const d3 = make();
    expect(status(await d3.status({ providers: ["claude-cli"] }), "claude-cli").support).toBe("blocked");
    const later = new Date(Date.now() + 5_000);
    utimesSync(fake.bin, later, later);
    expect(status(await d3.status({ providers: ["claude-cli"] }), "claude-cli").support).toBe("ready");
    expect(settings.get().cliBlocks).toEqual([]);
  });

  it("settings loaded from disk keep only well-formed CLI paths and blocks", () => {
    const file = join(tmp(), "agent-settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        cliPaths: { "claude-cli": "/opt/homebrew/bin/claude", "gemini-cli": "/tmp/evil.sh", "codex-cli": "codex", opencode: 42 },
        cliBlocks: [{ provider: "claude-cli", realPath: "/x/claude", size: 10, mtimeMs: 5, reason: "r", at: "t" }, { provider: "bash", realPath: "/bin/bash", size: 1, mtimeMs: 1 }, { provider: "gemini-cli", realPath: "", size: 1, mtimeMs: 1 }, "junk"],
      }),
    );
    const s = new SettingsStore(file).get();
    expect(s.cliPaths).toEqual({ "claude-cli": "/opt/homebrew/bin/claude" });
    expect(s.cliBlocks).toEqual([{ provider: "claude-cli", realPath: "/x/claude", size: 10, mtimeMs: 5, reason: "r", at: "t" }]);
  });

  it("keeps the newest lockdown blocks: past the cap the latest one still holds after a restart, and blocks on vanished files go", async () => {
    const root = tmp();
    const fake = makeFakeClaude(root);
    const settings = new SettingsStore(join(root, "agent-settings.json"));
    const make = () =>
      new CliDetector({ providers: CLI_PROVIDERS, env: probeEnv, cliPaths: () => ({}), searchDirs: [fake.binDir], loginShell: false, blocks: { load: () => settings.get().cliBlocks, save: (b) => settings.setCliBlocks(b) } });
    const d1 = make();
    await d1.status({ providers: ["claude-cli"] });
    // Earlier versioned binaries (Claude Code updates itself into a new path), still on disk, each blocked once: more than the cap.
    const versions = join(root, "versions");
    mkdirSync(versions);
    for (let i = 0; i < MAX_CLI_BLOCKS + 8; i++) {
      writeFileSync(join(versions, `claude-${i}`), "#!/bin/sh\n");
      d1.markBlocked("claude-cli", join(versions, `claude-${i}`), `old ${i}`);
    }
    d1.markBlocked("claude-cli", fake.realBin, "unexpected_tool: Bash");
    const saved = new SettingsStore(settings.file).get().cliBlocks;
    expect(saved).toHaveLength(MAX_CLI_BLOCKS);
    expect(saved.at(-1)).toMatchObject({ realPath: fake.realBin, reason: "unexpected_tool: Bash" });
    // "Restart": the binary that broke its lockdown is still refused, without a Re-check.
    const d2 = make();
    expect(status(await d2.status({ providers: ["claude-cli"] }), "claude-cli")).toMatchObject({ support: "blocked", supportDetail: expect.stringMatching(/lockdown violation/) });
    expect(d2.binary("claude-cli")).toBeNull();
    // The old versions are gone (the updater removed them): their blocks are dropped at the next start, in the file too.
    rmSync(versions, { recursive: true, force: true });
    const d3 = make();
    expect(d3.blocks().map((b) => b.realPath)).toEqual([fake.realBin]);
    expect(new SettingsStore(settings.file).get().cliBlocks.map((b) => b.realPath)).toEqual([fake.realBin]);
    expect(status(await d3.status({ providers: ["claude-cli"] }), "claude-cli").support).toBe("blocked");
  });

  it("a settings file with more blocks than the cap keeps the newest (the last ones)", () => {
    const file = join(tmp(), "agent-settings.json");
    const blocks = Array.from({ length: MAX_CLI_BLOCKS + 5 }, (_, i) => ({ provider: "claude-cli", realPath: `/x/claude-${i}`, size: 1, mtimeMs: i, reason: `r${i}`, at: "t" }));
    writeFileSync(file, JSON.stringify({ v: 1, cliBlocks: blocks }));
    const s = new SettingsStore(file);
    expect(s.get().cliBlocks.map((b) => b.realPath)).toEqual(blocks.slice(-MAX_CLI_BLOCKS).map((b) => b.realPath));
    s.setCliBlocks([...s.get().cliBlocks, { provider: "claude-cli", realPath: "/x/claude-new", size: 1, mtimeMs: 1, reason: "new", at: "t" }]);
    expect(new SettingsStore(file).get().cliBlocks.at(-1)).toMatchObject({ realPath: "/x/claude-new" });
    expect(new SettingsStore(file).get().cliBlocks).toHaveLength(MAX_CLI_BLOCKS);
  });

  it("the reset time of a plan that ran out is the used-up window's, not the latest window's", () => {
    const fiveHour = "2026-09-24T15:00:00.000Z";
    const sevenDay = "2026-09-27T05:50:00.000Z"; // ~63 h later, as in the recorded real Claude Code output
    const w = (utilization: number | null, resetsAt: string | null) => ({ utilization, resetsAt });
    expect(planResetAt([w(1, fiveHour), w(0.4, sevenDay)])).toBe(fiveHour);
    expect(planResetAt([w(0.4, sevenDay), w(1, fiveHour)])).toBe(fiveHour);
    // Both used up: usable again only once both have reset.
    expect(planResetAt([w(1, fiveHour), w(1, sevenDay)])).toBe(sevenDay);
    // Rounded below 100 %: the fullest window is the one that ran out.
    expect(planResetAt([w(0.99, fiveHour), w(0.6, sevenDay)])).toBe(fiveHour);
    // No utilization anywhere: the latest reset is the only safe answer.
    expect(planResetAt([w(null, fiveHour), w(null, sevenDay)])).toBe(sevenDay);
    // The used-up window has no reset time: unknown (never the other window's time).
    expect(planResetAt([w(1, null), w(0.4, sevenDay)])).toBeNull();
    expect(planResetAt([w(1, null)])).toBeNull();
    expect(planResetAt([])).toBeNull();
  });

  it("maps plan usage windows for display", () => {
    const v = planUsageView({ provider: "claude-cli", status: "allowed", windows: [{ id: "five_hour", utilization: 0.17, resetsAt: null }, { id: "seven_day", utilization: 0.05, resetsAt: null }], overage: null, observedAt: "2026-09-24T00:00:00.000Z" });
    expect(v.windows.map((w) => w.label)).toEqual(["5-hour", "7-day"]);
  });
});

describe("local models (Ollama), with an injected probe", () => {
  const running: OllamaStatus = {
    running: true,
    version: "0.34.2",
    models: [
      { tag: "qwen3:8b", family: "qwen3", parameterSize: "8.2B", tools: true, vision: false, thinking: true, contextLength: 40_960 },
      { tag: "llava:7b", family: "llama", parameterSize: "7B", tools: false, vision: true, thinking: false, contextLength: 4096 },
    ],
    detail: "2 model(s), 1 with tool calling",
  };

  it("lists tool-capable models as profiles, keeps unpulled suggestions, and caches the probe", async () => {
    let probes = 0;
    const l = new LocalModels({ baseUrl: () => null, probe: async () => (probes++, running) });
    const s = await l.status();
    await l.status();
    expect(probes).toBe(1);
    expect(s).toMatchObject({ id: "ollama", baseUrl: "http://127.0.0.1:11434", running: true, version: "0.34.2" });
    expect(s.models.map((m) => [m.id, m.tools])).toEqual([["ollama:qwen3:8b", true], ["ollama:llava:7b", false]]);
    const ids = l.profiles().map((p) => p.id);
    expect(ids).toContain("ollama:qwen3:8b");
    expect(ids).not.toContain("ollama:llava:7b"); // no tool calling: never offered for agent roles
    expect(ids).toContain("ollama:gpt-oss:20b"); // a suggestion, unavailable until pulled
    await l.status({ force: true });
    expect(probes).toBe(2);
    const moved = rebaseLocalProfile(l.profiles().find((p) => p.id === "ollama:gpt-oss:20b")!, "http://127.0.0.1:9999/");
    expect(moved.compat?.baseURL).toBe("http://127.0.0.1:9999/v1");
    expect(moved.local?.baseURL).toBe("http://127.0.0.1:9999");
  });

  it("a probe of an old URL never answers for a new one (the URL changed in Settings mid-probe)", async () => {
    let url: string | null = null;
    const release: Array<() => void> = [];
    const probed: string[] = [];
    const l = new LocalModels({
      baseUrl: () => url,
      probe: (u) => {
        probed.push(u);
        return new Promise((res) => release.push(() => res(u.includes("9999") ? running : { running: false, version: null, models: [], detail: "down" })));
      },
    });
    const first = l.status(); // probes the default URL
    await Promise.resolve();
    url = "http://127.0.0.1:9999";
    const second = l.status({ force: true }); // a different URL: its own probe, not the old one's promise
    await new Promise((r) => setTimeout(r, 0));
    expect(probed).toEqual(["http://127.0.0.1:11434", "http://127.0.0.1:9999"]);
    release[1]!();
    expect(await second).toMatchObject({ baseUrl: "http://127.0.0.1:9999", running: true });
    release[0]!(); // the old URL's answer arrives late and is dropped
    expect(await first).toMatchObject({ baseUrl: "http://127.0.0.1:9999", running: true });
    expect(l.view()).toMatchObject({ baseUrl: "http://127.0.0.1:9999", running: true });
    expect(l.profiles().map((p) => p.id)).toContain("ollama:qwen3:8b");
  });

  it("availability: running, pulled and tool-capable", () => {
    const view: LocalProviderStatus = { id: "ollama", baseUrl: "http://127.0.0.1:11434", running: true, version: "x", models: [{ id: "ollama:qwen3:8b", tag: "qwen3:8b", tools: true, vision: false, contextLength: 40960 }], detail: "" };
    const registry = profileRegistry();
    const r = readinessFrom([], view, null);
    expect(profileAvailability(registry.get("ollama:qwen3:8b"), r)).toEqual({ available: true });
    expect(profileAvailability(registry.get("ollama:gpt-oss:20b"), r)).toEqual({ available: false, reason: "not pulled: run `ollama pull gpt-oss:20b`" });
    expect(profileAvailability(registry.get("ollama:qwen3:8b"), readinessFrom([], { ...view, running: false }, null))).toMatchObject({ available: false, reason: "Ollama is not running" });
  });
});

describe("provider picture: availability, auto defaults and the settings view", () => {
  const ready = (id: string, over: Partial<CliProviderStatus> = {}): CliProviderStatus => ({
    id: id as CliProviderStatus["id"],
    label: CLI_PROVIDERS.get(id as never)!.label,
    installed: true,
    path: `/bin/${id}`,
    pathSource: "path",
    version: "1.0.0",
    support: "ready",
    supportDetail: "",
    lockdownLevel: "verified",
    residualRisks: [],
    auth: "logged_in",
    plan: "max",
    billing: "subscription",
    loginHint: "Run `x login` in a terminal",
    modes: ["completion", "runtime"],
    planUsage: null,
    checkedAt: "2026-09-24T00:00:00.000Z",
    ...over,
  });
  const registry = profileRegistry();
  const keys = (map: Record<string, string> = {}) => new KeyResolver(new KeyStore(join(tmp(), "k.json"), cipher()), map);

  it("prefers a ready, logged-in Claude Code over API keys (§9.3), with no key needed", () => {
    const r = readinessFrom([ready("claude-cli")], null, keys({ anthropic: "sk-ant-xxxxxxxxxxxxxxxx0000" }));
    expect(autoDefaults(r, registry)).toEqual({ provider: "claude-cli", models: { designer: "claude-cli:opus", spec_writer: "claude-cli:opus", triage: "claude-cli:haiku", judge: "claude-cli:fable" } });
  });

  it("falls through the order: logged-out CLIs are skipped, then keys, then Ollama; a missing judge comes from another family", () => {
    const loggedOut = readinessFrom([ready("claude-cli", { auth: "logged_out" }), ready("gemini-cli")], null, keys({ anthropic: "sk-ant-xxxxxxxxxxxxxxxx0000" }));
    expect(autoDefaults(loggedOut, registry)).toEqual({ provider: "gemini-cli", models: { designer: "gemini-cli:pro", spec_writer: "gemini-cli:pro", triage: "gemini-cli:flash-lite", judge: "claude-fable-5-1" } });
    expect(autoDefaults(readinessFrom([], null, keys({ openai: "sk-openai-xxxxxxxxxxxx0000" })), registry).provider).toBe("openai");
    const ollama: LocalProviderStatus = { id: "ollama", baseUrl: "http://127.0.0.1:11434", running: true, version: "x", models: [{ id: "ollama:qwen3:8b", tag: "qwen3:8b", tools: true, vision: false, contextLength: 40960 }], detail: "" };
    expect(autoDefaults(readinessFrom([], ollama, keys()), registry)).toMatchObject({ provider: "ollama", models: { designer: "ollama:qwen3:8b", triage: "ollama:qwen3:8b" } });
    expect(autoDefaults(readinessFrom([], null, keys()), registry)).toMatchObject({ provider: null, models: { designer: "claude-opus-5-5" } });
    // Blocked after a lockdown violation, nothing else set up: still the default, so a run says "press Re-check".
    const tripped = ready("claude-cli", { support: "blocked", supportDetail: "Stopped after a lockdown violation (unexpected_tool: Bash). Press Re-check to test it again.", modes: [] });
    expect(autoDefaults(readinessFrom([tripped], null, keys()), registry)).toMatchObject({ provider: "claude-cli", models: { designer: "claude-cli:opus" } });
    expect(autoDefaults(readinessFrom([tripped], null, keys({ openai: "sk-test-openai-0000000000" })), registry).provider).toBe("openai"); // anything ready wins
    expect(autoDefaults(readinessFrom([ready("cursor-agent", { support: "blocked", supportDetail: "web search cannot be disabled" })], null, keys()), registry).provider).toBeNull();
    // Nothing ready, but Claude Code only needs a login: default to it, so a run asks for the login, not a key.
    expect(autoDefaults(readinessFrom([ready("claude-cli", { auth: "logged_out" })], null, keys()), registry)).toMatchObject({ provider: "claude-cli", models: { designer: "claude-cli:opus" } });
  });

  it("the view lists every kind with availability and reasons, and never a secret", () => {
    const k = keys({ anthropic: "sk-ant-secret-value-000000001111" });
    const cursor = ready("cursor-agent", { support: "blocked", supportDetail: "web search cannot be disabled", modes: [] });
    const view = buildSettingsView({
      stored: new SettingsStore(join(tmp(), "s.json")).get(),
      keys: k,
      transport: "live",
      registry,
      cli: [ready("claude-cli"), ready("codex-cli", { support: "not_installed", installed: false }), cursor],
      local: null,
    });
    expect(JSON.stringify(view)).not.toContain("secret-value");
    expect(view.autoDefault).toEqual({ provider: "claude-cli", label: "Claude Code" });
    expect(view.models.designer).toBe("claude-cli:opus");
    const info = (id: string) => view.profiles.find((p) => p.id === id)!;
    expect(info("claude-cli:opus")).toMatchObject({ provider: "claude-cli", kind: "cli", billing: "subscription", available: true });
    expect(info("codex-cli:gpt-6-sol")).toMatchObject({ available: false, reason: "Codex CLI is not installed" });
    expect(info("cursor-agent:auto")).toMatchObject({ available: false, reason: expect.stringMatching(/not supported yet/) });
    expect(info("ollama:qwen3:8b")).toMatchObject({ provider: "ollama", kind: "local", billing: "local", available: false, reason: "Ollama is not running" });
    expect(info("claude-opus-5-5")).toMatchObject({ kind: "api", billing: "metered", available: true });
    expect(info("gpt-6-sol")).toMatchObject({ available: false, reason: "no OpenAI API key" });
    // CLI profiles first, then local, then API (the picker groups follow this order).
    expect(view.profiles[0]!.provider).toBe("claude-cli");
    expect(view.cliMode).toBe("auto");
    expect(BUILTIN_CLI_PROFILES.every((p) => view.profiles.some((x) => x.id === p.id))).toBe(true);
  });
});

describe("protocol additions (validated in the main process)", () => {
  const names = { "claude-cli": ["claude"], "gemini-cli": ["gemini"] };
  it("validates CLI paths, the CLI mode and the Ollama URL", () => {
    expect(parseSettingsUpdate({ v: 1, cliPaths: { "claude-cli": "/opt/homebrew/bin/claude", "gemini-cli": null }, cliMode: "completion", ollamaBaseUrl: "http://127.0.0.1:11434/" }, { cliBinaryNames: names })).toEqual({
      v: 1,
      cliPaths: { "claude-cli": "/opt/homebrew/bin/claude", "gemini-cli": null },
      cliMode: "completion",
      ollamaBaseUrl: "http://127.0.0.1:11434",
    });
    expect(() => parseSettingsUpdate({ v: 1, cliPaths: { "claude-cli": "claude" } }, { cliBinaryNames: names })).toThrow(/absolute path/);
    expect(() => parseSettingsUpdate({ v: 1, cliPaths: { "claude-cli": "/tmp/evil.sh" } }, { cliBinaryNames: names })).toThrow(/must point to claude/);
    expect(() => parseSettingsUpdate({ v: 1, cliPaths: { bash: "/bin/bash" } }, { cliBinaryNames: names })).toThrow(/cliPaths provider/);
    expect(() => parseSettingsUpdate({ v: 1, cliMode: "yolo" })).toThrow(/cliMode/);
    expect(() => parseSettingsUpdate({ v: 1, ollamaBaseUrl: "http://192.168.1.5:11434" })).toThrow(/https/);
    expect(parseProbeProvidersRequest({ v: 1, providers: ["claude-cli", "ollama", "claude-cli"] })).toEqual({ v: 1, providers: ["claude-cli", "ollama"] });
    expect(() => parseProbeProvidersRequest({ v: 1, providers: ["bash"] })).toThrow(/providers\[0\]/);
  });

  it("parses the worker's lockdown and process-group reports", () => {
    expect(parseWorkerMessage({ v: 1, type: "cli", kind: "lockdown_violation", provider: "claude-cli", realPath: "/x/claude", detail: "unexpected_tool: Bash" })).toEqual({ v: 1, type: "cli", kind: "lockdown_violation", provider: "claude-cli", realPath: "/x/claude", detail: "unexpected_tool: Bash" });
    expect(parseWorkerMessage({ v: 1, type: "cli", kind: "lockdown_violation", provider: "bash", realPath: "/x" })).toBeNull();
    expect(parseWorkerMessage({ v: 1, type: "procs", pids: [123, 1, -5, "x", 456] })).toEqual({ v: 1, type: "procs", pids: [123, 456] });
  });

  it("gives CLI children the login locations and proxies, but never the worker itself; never a credential", () => {
    const host = {
      PATH: "/bin",
      HOME: "/h",
      CLAUDE_CONFIG_DIR: "/h/.claude",
      XDG_CONFIG_HOME: "/h/.config",
      HTTPS_PROXY: "http://proxy:3128",
      no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      NODE_OPTIONS: "--require /tmp/evil.js",
      ANTHROPIC_BASE_URL: "https://evil.example",
      ANTHROPIC_API_KEY: "a",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
      GEMINI_API_KEY: "g",
      CODEX_API_KEY: "c",
      DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
    };
    // The utility process holds the API keys: no CA, proxy or CLI location variable enters its own environment.
    expect(agentWorkerEnv(host)).toEqual({ PATH: "/bin", HOME: "/h" });
    // CLI children get them per run (WorkerCliConfig.childEnv), and nothing else.
    expect(cliChildHostEnv(host)).toEqual({
      CLAUDE_CONFIG_DIR: "/h/.claude",
      XDG_CONFIG_HOME: "/h/.config",
      HTTPS_PROXY: "http://proxy:3128",
      no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
    });
    // The worker accepts only those names from the start message (defence in depth).
    expect(cliChildEnv({ HTTPS_PROXY: "http://proxy:3128", NODE_OPTIONS: "--require /tmp/evil.js", ANTHROPIC_API_KEY: "a", CODEX_HOME: "/h/.codex", X: 1 })).toEqual({ HTTPS_PROXY: "http://proxy:3128", CODEX_HOME: "/h/.codex" });
  });
});

// ─── Host: precheck, worker config, reports ─────────────────────────────────────────────────

class FakeWorker implements WorkerHandle {
  sent: HostToWorker[] = [];
  #onMessage: ((m: unknown) => void) | null = null;
  #onExit: ((code: number) => void) | null = null;
  postMessage(m: HostToWorker): void {
    this.sent.push(m);
  }
  kill(): void {}
  onMessage(l: (m: unknown) => void): void {
    this.#onMessage = l;
  }
  onExit(l: (code: number) => void): void {
    this.#onExit = l;
  }
  reply(m: WorkerToHost): void {
    this.#onMessage?.(m);
  }
  exit(code: number): void {
    this.#onExit?.(code);
  }
}

function cliHost(binDir: string, options: { ollama?: OllamaStatus; cliRun?: { childEnv?: Record<string, string>; autoMode?: "runtime" | "completion" }; stopGraceMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const events: AgentEvent[] = [];
  const killed: number[] = [];
  const settings = new SettingsStore(join(tmp(), "s.json"));
  const workspaceRoot = join(tmp(), "cli-work");
  const d = new CliDetector({
    providers: CLI_PROVIDERS,
    env: probeEnv,
    cliPaths: () => settings.get().cliPaths,
    searchDirs: [binDir],
    loginShell: false,
    blocks: { load: () => settings.get().cliBlocks, save: (b) => settings.setCliBlocks(b) }, // as setup.ts wires it
  });
  const local = new LocalModels({ baseUrl: () => settings.get().ollamaBaseUrl, probe: async () => options.ollama ?? { running: false, version: null, models: [], detail: "Ollama is not reachable" } });
  const h = new AgentHost({
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    keys: new KeyResolver(new KeyStore(join(tmp(), "k.json"), cipher())),
    settings,
    transport: { kind: "live" },
    forgeBin: "/bin/aicad",
    send: (e) => events.push(e),
    cli: d,
    local,
    cliRun: { workspaceRoot, exePath: null, mcpServerDir: null, ...options.cliRun },
    killProcessGroup: (pid) => killed.push(pid),
    newRunId: () => `run-${workers.length}-${events.length}`,
    ...(options.stopGraceMs !== undefined ? { stopGraceMs: options.stopGraceMs } : {}),
  });
  return { h, workers, events, killed, settings, detector: d, workspaceRoot };
}

describe.skipIf(!posix)("agent host with CLI providers (keyless)", () => {
  it("starts a Claude Code run with no API key: CLI binary in the config, no secrets", async () => {
    const fake = makeFakeClaude(tmp());
    const { h, workers } = cliHost(fake.binDir);
    const view = await h.settingsView();
    expect(view.autoDefault).toEqual({ provider: "claude-cli", label: "Claude Code" });
    expect(view.providers.every((p) => !p.configured)).toBe(true);
    const r = await h.start(START);
    expect(r).toMatchObject({ ok: true });
    const start = workers[0]!.sent[0] as Extract<HostToWorker, { type: "start" }>;
    expect(start.secrets).toEqual({});
    expect(start.config.models).toEqual({ designer: "claude-cli:opus", spec_writer: "claude-cli:opus", triage: "claude-cli:haiku", judge: "claude-cli:fable" });
    expect(Object.keys(start.config.cli!.binaries)).toEqual(["claude-cli"]);
    expect(start.config.cli).toMatchObject({ mode: "auto", exePath: null });
    const b = binaryFromWire(start.config.cli!.binaries["claude-cli"]!);
    expect(b).toMatchObject({ path: fake.bin, realPath: fake.realBin, version: "2.1.260" });
    expect(b.help.flags.has("--strict-mcp-config")).toBe(true);
    expect(binaryToWire(b)).toEqual(start.config.cli!.binaries["claude-cli"]);
    expect(JSON.parse(JSON.stringify(start.config.cli))).toEqual(start.config.cli); // plain JSON across the process boundary
  });

  it("refuses with the CLI's code, the roles and the fix", async () => {
    const fake = makeFakeClaude(tmp(), { loggedIn: false });
    const { h, workers, detector: d, settings } = cliHost(fake.binDir);
    // Logged out: no auto default, so pick the CLI explicitly (as a user would).
    settings.update({ v: 1, models: { designer: "claude-cli:opus" } }, h.registry);
    expect(await h.start(START)).toEqual({
      ok: false,
      code: "CLI_NOT_LOGGED_IN",
      message:
        "Claude Code is installed but not logged in (designer: Claude Opus (Claude Code, your plan), spec_writer: Claude Opus (Claude Code, your plan), triage: Claude Haiku (Claude Code, your plan)). Run `claude auth login` in a terminal, then press Re-check.",
    });
    fake.setLoggedIn(true);
    await h.probeProviders({ v: 1, providers: ["claude-cli"] });
    d.markBlocked("claude-cli", fake.realBin, "unexpected_tool: Bash");
    expect(await h.start(START)).toMatchObject({ ok: false, code: "CLI_BLOCKED" });
    await h.probeProviders({ v: 1 });
    settings.update({ v: 1, models: { designer: "gemini-cli:pro" } }, h.registry);
    expect(await h.start(START)).toMatchObject({ ok: false, code: "CLI_NOT_INSTALLED", message: expect.stringMatching(/^Gemini CLI is not installed \(designer: Gemini Pro/) });
    settings.update({ v: 1, models: { designer: "ollama:qwen3:8b" } }, h.registry);
    expect(await h.start(START)).toMatchObject({ ok: false, code: "LOCAL_UNAVAILABLE", message: expect.stringMatching(/Ollama is not running at http:\/\/127\.0\.0\.1:11434/) });
    expect(workers).toHaveLength(0);
  });

  it("stores a validated CLI path, caches plan usage, blocks after a violation and kills CLI groups if the worker dies", async () => {
    const root = tmp();
    const fake = makeFakeClaude(root);
    // Detection is restricted to `root`, which holds the fake only in `bin/`: found through the Settings path alone.
    const { h, workers, killed, settings } = cliHost(root);
    expect((await h.settingsView()).cli!.find((c) => c.id === "claude-cli")!.support).toBe("not_installed");
    await expect(h.updateSettings({ v: 1, cliPaths: { "claude-cli": join(tmp(), "claude") } })).rejects.toThrow(/does not exist/);
    const view = await h.updateSettings({ v: 1, cliPaths: { "claude-cli": fake.bin } });
    expect(settings.get().cliPaths).toEqual({ "claude-cli": fake.bin });
    expect(view.cli!.find((c) => c.id === "claude-cli")).toMatchObject({ support: "ready", pathSource: "settings" });

    const r = (await h.start(START)) as { ok: true; runId: string };
    const w = workers[0]!;
    const usage = { status: "allowed" as const, windows: [{ id: "five_hour", label: "5-hour", utilization: 0.17, resetsAt: null }], observedAt: "2026-09-24T00:00:00.000Z" };
    w.reply({ type: "event", v: 1, event: { v: 1, runId: r.runId, seq: 1, t: 1, type: "plan", provider: "claude-cli", usage } });
    expect((await h.settingsView()).cli!.find((c) => c.id === "claude-cli")!.planUsage).toEqual(usage);
    w.reply({ type: "procs", v: 1, pids: [4242, 4343] });
    w.reply({ type: "cli", v: 1, kind: "lockdown_violation", provider: "claude-cli", realPath: fake.realBin, detail: "unexpected_tool: Bash" });
    expect((await h.settingsView()).cli!.find((c) => c.id === "claude-cli")!.support).toBe("blocked");
    w.exit(1);
    expect(killed).toEqual([4242, 4343]);
    // The block was saved with the settings: it outlives this host (an app restart).
    expect(settings.get().cliBlocks).toEqual([expect.objectContaining({ provider: "claude-cli", realPath: fake.realBin })]);
  });

  it("sends CLI children's login locations and proxies in the start config, and resolves `auto` for test profiles", async () => {
    const fake = makeFakeClaude(tmp());
    const { h, workers, settings } = cliHost(fake.binDir, { cliRun: { childEnv: { HTTPS_PROXY: "http://proxy:3128", CLAUDE_CONFIG_DIR: "/h/.claude" }, autoMode: "completion" } });
    expect(await h.start(START)).toMatchObject({ ok: true });
    const start = workers[0]!.sent[0] as Extract<HostToWorker, { type: "start" }>;
    expect(start.config.cli).toMatchObject({ mode: "completion", childEnv: { HTTPS_PROXY: "http://proxy:3128", CLAUDE_CONFIG_DIR: "/h/.claude" } });
    // An explicit setting is always honored.
    settings.update({ v: 1, cliMode: "runtime" }, h.registry);
    workers[0]!.reply({ type: "event", v: 1, event: { v: 1, runId: (start as { runId: string }).runId, seq: 1, t: 1, type: "error", code: "X", message: "x" } });
    expect(await h.start(START)).toMatchObject({ ok: true });
    expect((workers[0]!.sent.at(-1) as Extract<HostToWorker, { type: "start" }>).config.cli!.mode).toBe("runtime");
  });

  it("a plan that ran out shows the used-up window's reset, not the latest window's, in Settings and in the next run's note", async () => {
    const fake = makeFakeClaude(tmp());
    const { h, workers } = cliHost(fake.binDir);
    const r = (await h.start(START)) as { ok: true; runId: string };
    const fiveHour = "2026-09-24T15:00:00.000Z";
    const sevenDay = "2026-09-27T05:50:00.000Z"; // resets ~63 h later, as in the recorded real output
    const usage = {
      status: "rejected" as const,
      windows: [
        { id: "five_hour", label: "5-hour", utilization: 1, resetsAt: fiveHour },
        { id: "seven_day", label: "7-day", utilization: 0.4, resetsAt: sevenDay },
      ],
      observedAt: "2026-09-24T12:00:00.000Z",
    };
    workers[0]!.reply({ type: "event", v: 1, event: { v: 1, runId: r.runId, seq: 1, t: 1, type: "plan", provider: "claude-cli", usage } });
    workers[0]!.reply({ type: "event", v: 1, event: { v: 1, runId: r.runId, seq: 2, t: 2, type: "error", code: "X", message: "x" } });
    const view = await h.settingsView();
    expect(view.warnings).toEqual([`Claude Code: the plan's usage limit was reached at the last run (resets ${fiveHour}).`]);
    expect(await h.start(START)).toMatchObject({ ok: true });
    const next = workers[0]!.sent.at(-1) as Extract<HostToWorker, { type: "start" }>;
    expect(next.config.notes).toContain(`Claude Code: the plan's usage limit was reached at the last run (resets ${fiveHour}); the run may stop with quota_exhausted.`);
    expect(JSON.stringify(next.config.notes)).not.toContain(sevenDay);
  });

  it("quitting empties the workspace root: an interrupted phase's workspace and socket folder do not outlive the app", async () => {
    const fake = makeFakeClaude(tmp());
    const { h, workers, killed, workspaceRoot } = cliHost(fake.binDir);
    const r = (await h.start(START)) as { ok: true; runId: string };
    // What a runtime phase leaves while it runs: the holder with the CLI's cwd (system prompt, an attachment, its
    // TMPDIR) and the broker's socket folder; plus a detection probe folder.
    const cwd = join(workspaceRoot, "0123456789abcdef", "aicad-run");
    mkdirSync(join(cwd, ".tmp"), { recursive: true, mode: 0o700 });
    writeFileSync(join(cwd, "system.md"), "phase system prompt");
    writeFileSync(join(cwd, ".tmp", "crash.log"), "design text");
    mkdirSync(join(workspaceRoot, "s", "89abcdef"), { recursive: true });
    mkdirSync(join(workspaceRoot, "fedcba9876543210"));
    writeFileSync(join(workspaceRoot, "README"), "not a workspace: left alone");
    workers[0]!.reply({ type: "procs", v: 1, pids: [4242] });
    expect(r.ok).toBe(true);
    h.dispose(); // Electron `will-quit`
    expect(killed).toEqual([4242]);
    expect(readdirSync(workspaceRoot)).toEqual(["README"]); // the emptied socket folder goes too
    rmSync(join(workspaceRoot, "README"));
    h.dispose();
    expect(existsSync(workspaceRoot)).toBe(false); // an empty root goes as well (the gateway recreates it, 0700)
  });

  it("a replaced worker's late exit does not kill the CLI process groups of the worker that replaced it", async () => {
    const fake = makeFakeClaude(tmp());
    const { h, workers, killed } = cliHost(fake.binDir, { stopGraceMs: 10 });
    const r1 = (await h.start(START)) as { ok: true; runId: string };
    workers[0]!.reply({ type: "procs", v: 1, pids: [111] });
    expect(h.stop({ v: 1, runId: r1.runId })).toEqual({ ok: true });
    await new Promise((res) => setTimeout(res, 60)); // the stop timeout: that worker and its CLIs are killed
    expect(killed).toEqual([111]);
    expect(await h.start(START)).toMatchObject({ ok: true });
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ type: "procs", v: 1, pids: [222] });
    workers[0]!.exit(0); // the old worker's exit arrives late
    expect(killed).toEqual([111]);
    workers[1]!.exit(1); // the current worker crashes: its CLIs go
    expect(killed).toEqual([111, 222]);
  });

  it("with no private workspace root, CLI agents are off: Settings says why and a run on a CLI model is refused", async () => {
    const settings = new SettingsStore(join(tmp(), "s.json"));
    const off = "CLI agents are off: the app's data folder is inside /shared, which other users of this computer can write to, and no private folder was found for their workspaces";
    const workers: FakeWorker[] = [];
    const h = new AgentHost({
      spawnWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      keys: new KeyResolver(new KeyStore(join(tmp(), "k.json"), cipher())),
      settings,
      transport: { kind: "live" },
      forgeBin: "/bin/aicad",
      send: () => undefined,
      cli: new CliDetector({ providers: new Map(), env: probeEnv, cliPaths: () => ({}), searchDirs: [], loginShell: false }),
      cliOff: off,
    });
    const view = await h.settingsView();
    expect(view.warnings).toContain(`${off}.`);
    expect(view.cli).toEqual([]);
    settings.update({ v: 1, models: { designer: "claude-cli:opus" } }, h.registry);
    const r = await h.start(START);
    expect(r).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect((r as { message: string }).message).toMatch(/^Claude Code cannot run: CLI agents are off: .*no private folder was found for their workspaces \(designer: Claude Opus \(Claude Code, your plan\).*\)\. Pick another model in Settings\.$/);
    expect(workers).toHaveLength(0);
  });
});

describe("CLI workspace root (broker socket length, private ancestors, §5.4)", () => {
  // Short enough for the broker socket under the per-user temp dir (the suite's own prefix is too long for that).
  const short = tempDirs("a");
  /** Whether a fallback `base` is usable here: private all the way up and short enough (a shared /tmp on Linux CI is not). */
  const usable = (base: string, userData: string): boolean => brokerSocketFits(join(base, profileWorkspaceDir(userData))) && unsafeAncestor(base) === null;

  it("keeps <userData>/cli-work when the socket fits, else this profile's folder in a private root, else stays and says why", () => {
    expect(brokerSocketFits("/Users/me/Library/Application Support/aicad/cli-work", "darwin")).toBe(true);
    const long = `/var/folders/w5/w0kv7_9j1d92sn_hhzdc13v00000gn/T/aicad-e2e-providers-AbCdEf/user-data`;
    expect(brokerSocketFits(join(long, "cli-work"), "darwin")).toBe(false);
    expect(brokerSocketFits(join(long, "cli-work"), "win32")).toBe(true); // named pipes
    expect(cliWorkspaceRoot("/Users/me/Library/Application Support/aicad")).toEqual({ root: "/Users/me/Library/Application Support/aicad/cli-work", note: null });
    if (process.platform === "win32") return;
    const privateShort = short();
    const r = cliWorkspaceRoot(long, () => privateShort);
    if (usable(privateShort, long)) {
      const alt = join(privateShort, profileWorkspaceDir(long));
      expect(r).toEqual({ root: alt, note: `CLI workspaces use ${alt}: the path of the app's data folder is too long for the MCP broker socket (103 bytes)` });
    }
    // One folder per profile: the root stays exclusive to one app instance (the app empties it at start and on quit).
    expect(profileWorkspaceDir(`${long}-2`)).not.toBe(profileWorkspaceDir(long));
    expect(profileWorkspaceDir(long)).toMatch(/^app-[0-9a-f]{10}$/);
    // Never a shared, world-writable folder such as /tmp: CLIs read config files upward from their working directory.
    expect(cliWorkspaceRoot(long, () => "/tmp/aicad-cli")).toMatchObject({ root: join(long, "cli-work"), note: expect.stringMatching(/one call at a time/) });
  });

  it.skipIf(!posix)("never uses <userData>/cli-work when a folder above it is writable by other users (mode 0777)", () => {
    const shared = join(short(), "sh");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const userData = join(shared, "ud");
    mkdirSync(userData);
    expect(unsafeAncestor(userData)).toBe(shared);
    // Short enough for the socket: only the shared parent rules it out (another user could plant opencode.json,
    // .opencode/ or AGENTS.md there, which CLIs read upward from their working folder).
    expect(brokerSocketFits(join(userData, "cli-work"))).toBe(true);
    const privateShort = short();
    const r = cliWorkspaceRoot(userData, () => privateShort);
    expect(r.root).not.toBe(join(userData, "cli-work"));
    if (usable(privateShort, userData)) {
      const alt = join(privateShort, profileWorkspaceDir(userData));
      expect(r).toEqual({ root: alt, note: `CLI workspaces use ${alt}: the app's data folder is inside ${shared}, which other users of this computer can write to` });
    } else {
      expect(r).toMatchObject({ root: null, note: expect.stringMatching(/^CLI agents are off/) });
    }
    // No private fallback either (a shared /tmp, or none at all): CLI agents are off, with the reason.
    for (const fallback of [() => "/tmp/aicad-cli", (): string => { throw new Error("no default root"); }]) {
      const off = cliWorkspaceRoot(userData, fallback);
      expect(off.root).toBeNull();
      expect(off.note).toBe(
        `CLI agents are off: the app's data folder is inside ${shared}, which other users of this computer can write to, and no private folder was found for their workspaces (CLIs read config files from every folder above their working folder)`,
      );
    }
  });
});

/** `setupAgent` options for an isolated profile: no real CLI, no Ollama, a fake worker. */
function setupOptions(userData: string, workers: FakeWorker[] = []): AgentSetupOptions {
  return {
    userData,
    env: {},
    isPackaged: false,
    repoRoot: null,
    forgeBin: "/nonexistent/aicad",
    cipher: cipher(),
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    send: () => undefined,
    log: () => undefined,
    detectEnv: probeEnv(),
    cliDirs: [],
    exePath: null,
    ollamaProbe: async () => ({ running: false, version: null, models: [], detail: "off" }),
    detectLocalModels: false,
  };
}

describe.skipIf(!posix)("setupAgent and the CLI workspace root (§5.4, §5.8)", () => {
  it("empties the app's own root at start (a crashed session's leftovers) and on quit", () => {
    const userData = tmp();
    const root = join(userData, "cli-work");
    if (cliWorkspaceRoot(userData).root !== root) return; // a shared or too long temp dir: covered by the tests above
    const cwd = join(root, "0123456789abcdef", "w");
    mkdirSync(join(cwd, ".tmp"), { recursive: true });
    writeFileSync(join(cwd, "system.md"), "phase system prompt");
    mkdirSync(join(root, "s", "89abcdef"), { recursive: true });
    writeFileSync(join(root, "README"), "not a workspace: left alone");
    const setup = setupAgent(setupOptions(userData));
    try {
      expect(defaultWorkspaceRoot()).toBe(root); // detection probes use it too
      expect(readdirSync(root)).toEqual(["README"]);
      mkdirSync(join(root, "fedcba9876543210", "aicad-run", ".tmp"), { recursive: true });
      mkdirSync(join(root, "s", "01234567"), { recursive: true });
      setup.host.dispose();
      expect(readdirSync(root)).toEqual(["README"]);
    } finally {
      setup.host.dispose();
      setDefaultWorkspaceRoot(null);
    }
  });

  it("with the data folder under a shared folder, no CLI workspace ever goes there: a per-profile private root, or CLI agents off", async () => {
    const shared = join(tmp(), "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const userData = join(shared, "aicad");
    mkdirSync(userData);
    const setup = setupAgent(setupOptions(userData));
    try {
      const view = await setup.host.settingsView();
      const off = view.warnings.find((w) => w.startsWith("CLI agents are off"));
      if (off === undefined) {
        const root = defaultWorkspaceRoot();
        expect(root.startsWith(userData)).toBe(false);
        expect(basename(root)).toBe(profileWorkspaceDir(userData));
        expect(unsafeAncestor(dirname(root))).toBeNull();
      } else {
        expect(view.cli).toEqual([]);
      }
      expect(existsSync(join(userData, "cli-work"))).toBe(false);
    } finally {
      setup.host.dispose();
      setDefaultWorkspaceRoot(null);
    }
  });
});

// ─── Worker: a keyless run end to end through the fake CLI ──────────────────────────────────

function runner(options: { env?: Record<string, string> } = {}) {
  const events: AgentEvent[] = [];
  const posts: WorkerToHost[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const listeners: Array<(e: AgentEvent) => void> = [];
  const r = new AgentRunner({
    post: (m) => {
      posts.push(m);
      if (m.type !== "event") return;
      events.push(m.event);
      for (const l of listeners) l(m.event);
      if (m.event.type === "result" || m.event.type === "error") resolveDone();
    },
    env: () => options.env ?? probeEnv(),
    loadMcpServer: async () => null,
    loadCliRuntime: async () => null,
  });
  const waitFor = (type: AgentEvent["type"]): Promise<AgentEvent> =>
    new Promise((res) => {
      const hit = events.find((e) => e.type === type);
      if (hit) return res(hit);
      listeners.push((e) => e.type === type && res(e));
    });
  return { r, events, posts, done, waitFor };
}

async function cliStart(root: string, fake: { binDir: string }, runId: string): Promise<Extract<HostToWorker, { type: "start" }>> {
  const { d } = detector(fake.binDir);
  await d.status({ providers: ["claude-cli"] });
  const b = d.binary("claude-cli")!;
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
      cli: { binaries: { "claude-cli": binaryToWire(b) }, mode: "auto", workspaceRoot: join(root, "cli-work"), exePath: null, mcpServerDir: null },
    },
    secrets: {},
  };
}

describe.skipIf(!posix || !existsSync(wasm))("agent runner with Claude Code (fake CLI, no key, no network)", () => {
  it("runs 'make the plate 2 mm thicker' end to end through locked-down CLI invocations", async () => {
    const root = tmp();
    const fake = makeFakeClaude(root, { costUsd: 0.004 });
    const { r, events, done, waitFor } = runner({ env: { ...probeEnv(), ANTHROPIC_API_KEY: "sk-ant-must-not-reach-the-cli-000", CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak-token-0001" } });
    const start = await cliStart(root, fake, "run-cli");
    r.handle(start);
    const q = (await waitFor("question")) as Extract<AgentEvent, { type: "question" }>;
    expect(q.questions[0]).toMatchObject({ id: "q1", default: "Up (+Z), keep the bottom face on the build plate" });
    r.handle({ type: "answer", v: 1, runId: "run-cli", questionId: q.questionId, answers: [""] });
    await done;

    const started = events[0] as Extract<AgentEvent, { type: "started" }>;
    expect(started).toMatchObject({ type: "started", transport: "live" });
    expect(started.models.designer).toEqual({ id: "claude-cli:opus", name: "Claude Opus (Claude Code, your plan)", provider: "claude-cli", kind: "cli", billing: "subscription" });
    const res = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(res).toMatchObject({ status: "proposed", stopReason: "proposed", changed: true, verified: true, billing: "subscription" });
    expect(res.proposedSource).toBe(NEMA.replace("distance: 5", "distance: 7"));
    // Notional cost: the CLI's own list-price total per invocation (4 calls × $0.004), flagged as plan usage.
    expect(res.costUsd).toBeCloseTo(0.016, 6);
    const costs = events.filter((e): e is Extract<AgentEvent, { type: "cost" }> => e.type === "cost");
    expect(costs.every((c) => c.notional === true)).toBe(true);
    const llm = events.filter((e): e is Extract<AgentEvent, { type: "llm" }> => e.type === "llm");
    expect(llm.map((e) => [e.role, e.model, e.billing])).toEqual([
      ["triage", "claude-cli:haiku", "subscription"],
      ["designer", "claude-cli:opus", "subscription"],
      ["designer", "claude-cli:opus", "subscription"],
      ["designer", "claude-cli:opus", "subscription"],
    ]);
    const plan = events.find((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>;
    expect(plan).toMatchObject({ provider: "claude-cli", usage: { status: "allowed", windows: [{ id: "five_hour", label: "5-hour", utilization: 0.17 }, { id: "seven_day", label: "7-day", utilization: 0.05 }] } });
    // Each report arrives through the gateway's CLI hook and the orchestrator's onPlanUsage: emitted once, not twice.
    const plans = events.filter((e): e is Extract<AgentEvent, { type: "plan" }> => e.type === "plan").map((e) => JSON.stringify(e.usage));
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.length).toBeLessThanOrEqual(4);
    expect(plans.every((p, i) => i === 0 || p !== plans[i - 1])).toBe(true);

    // The lockdown the gateway applied, as the fake CLI saw it.
    const calls = fake.calls();
    expect(calls.map((c) => [c.role, c.turn])).toEqual([
      ["triage", 0],
      ["designer", 0],
      ["designer", 1],
      ["designer", 2],
    ]);
    for (const c of calls) {
      expect(c.argv).toEqual(expect.arrayContaining(["-p", "--restricted", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence", "--json-schema"]));
      expect(c.argv[c.argv.indexOf("--tools") + 1]).toBe(""); // every built-in tool off
      expect(c.argv[c.argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
      expect(c.argv).not.toContain("--bare"); // would disable the user's subscription login
      expect(c.promptInArgv).toBe(false); // the prompt goes through stdin
      expect(c.stdinBytes).toBeGreaterThan(100);
      expect(c.cwdMode).toBe(0o700);
      expect(unprivate(c.tmpdir ?? "")).toBe(join(unprivate(c.cwd), ".tmp")); // TMPDIR inside the workspace
      expect(unprivate(c.cwd).startsWith(unprivate(join(root, "cli-work")))).toBe(true);
      expect(c.env.filter((k) => /API_?KEY|TOKEN|SECRET|^ANTHROPIC_|^CLAUDE_CODE_OAUTH/.test(k))).toEqual([]);
      expect(c.env).toContain("CLAUDE_CODE_DISABLE_CLAUDE_MDS");
      expect(existsSync(c.cwd)).toBe(false); // each workspace is deleted after its invocation
    }
    expect(calls.find((c) => c.role === "triage")!.argv).toContain("--model=haiku");
    expect(calls.find((c) => c.role === "designer")!.argv).toContain("--model=opus");
    // Only the (empty) socket folder is left under the workspace root.
    expect(readdirSync(join(root, "cli-work")).filter((n) => n !== "s")).toEqual([]);
  });

  it("a CLI that reports a built-in tool stops the run and is reported for blocking", async () => {
    const root = tmp();
    const fake = makeFakeClaude(root, { initTools: ["Bash", "StructuredOutput"] });
    const { r, events, posts, done } = runner();
    r.handle(await cliStart(root, fake, "run-trip"));
    await done;
    const res = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(res).toMatchObject({ status: "failed", stopReason: "model_error", changed: false });
    expect(res.message).toMatch(/lockdown_violation/);
    const report = posts.find((m) => m.type === "cli");
    expect(report).toMatchObject({ type: "cli", kind: "lockdown_violation", provider: "claude-cli", realPath: fake.realBin, detail: expect.stringMatching(/Bash/) });
    expect(fake.calls()).toHaveLength(1);
  });

  it("a logged-out CLI ends the run with the login hint, not a hang", async () => {
    const root = tmp();
    const fake = makeFakeClaude(root);
    const start = await cliStart(root, fake, "run-out");
    fake.setLoggedIn(false);
    const { r, events, done } = runner();
    r.handle(start);
    await done;
    const res = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(res).toMatchObject({ status: "failed", stopReason: "model_error" });
    expect(res.message).toMatch(/not_logged_in/);
  });

  it("a workspace root too long for the broker socket is caught up front: single calls, with a note, no runtime", async () => {
    const root = tmp();
    const fake = makeFakeClaude(root);
    const start = await cliStart(root, fake, "run-long");
    const long = join(root, "x".repeat(90));
    start.config.cli = { ...start.config.cli!, workspaceRoot: long, exePath: process.execPath, mcpServerDir: join(repo, "packages", "mcp-server") };
    let runtimeLoads = 0;
    let mcpLoads = 0;
    const events: AgentEvent[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((res) => (resolveDone = res));
    const r = new AgentRunner({
      post: (m) => {
        if (m.type !== "event") return;
        events.push(m.event);
        const e = m.event;
        if (e.type === "question") setTimeout(() => r.handle({ type: "answer", v: 1, runId: "run-long", questionId: e.questionId, answers: [""] }), 0);
        if (m.event.type === "result" || m.event.type === "error") resolveDone();
      },
      env: probeEnv,
      loadMcpServer: async () => (mcpLoads++, null),
      loadCliRuntime: async () => (runtimeLoads++, null),
    });
    r.handle(start);
    await done;
    expect(runtimeLoads).toBe(0);
    expect(mcpLoads).toBe(0);
    const notes = events.filter((e): e is Extract<AgentEvent, { type: "note" }> => e.type === "note").map((e) => e.text);
    expect(notes.filter((t) => /too long for the CAD MCP broker's socket/.test(t))).toHaveLength(1);
    expect((events.at(-1) as Extract<AgentEvent, { type: "result" }>).result).toMatchObject({ status: "proposed", changed: true });
  });

  it("Stop during a CLI invocation kills its process group, removes the workspace and ends the run cancelled", async () => {
    const root = tmp();
    const fake = makeFakeClaude(root, { delayMs: 60_000 }); // answers only after a minute
    const { r, events, done } = runner();
    r.handle(await cliStart(root, fake, "run-stop"));
    const t0 = Date.now();
    while (fake.calls().length === 0 && Date.now() - t0 < 15_000) await new Promise((res) => setTimeout(res, 25));
    expect(fake.calls()).toHaveLength(1); // the triage call is in flight
    expect(liveCliProcessGroups().length).toBeGreaterThan(0);
    r.handle({ type: "stop", v: 1, runId: "run-stop" });
    await done;
    expect(Date.now() - t0).toBeLessThan(20_000);
    const res = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(res).toMatchObject({ stopReason: "cancelled", changed: false });
    expect(liveCliProcessGroups()).toEqual([]);
    const work = join(root, "cli-work");
    expect(readdirSync(work).filter((n) => n !== "s")).toEqual([]); // the invocation's workspace is gone
    expect(existsSync(join(work, "s")) ? readdirSync(join(work, "s")) : []).toEqual([]);
    expect(existsSync(fake.calls()[0]!.cwd)).toBe(false);
  });

  it("a used-up plan stops the run with the reset time, a rejected plan report and a quota marker", async () => {
    const root = tmp();
    const binDir = join(root, "bin");
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    const mod = new URL("./fixtures/fake-claude-quota.mjs", import.meta.url).href;
    const fs = await import("node:fs");
    fs.mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "claude"), `#!/usr/bin/env node\nimport(${JSON.stringify(mod)}).then((m) => m.main(${JSON.stringify({ help: FAKE_CLAUDE_HELP, resetsAt })}));\n`);
    chmodSync(join(binDir, "claude"), 0o755);
    const { r, events, done } = runner();
    r.handle(await cliStart(root, { binDir }, "run-quota"));
    await done;
    const iso = new Date(resetsAt * 1000).toISOString();
    const res = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(res).toMatchObject({ status: "failed", stopReason: "model_error", changed: false, quota: { kind: "quota_exhausted", provider: "claude-cli", resetsAt: iso } });
    expect(res.message).toContain(`resets at ${iso}`);
    expect(res.message).toMatch(/^Claude Code: your plan's usage limit is reached/);
    expect(res.message).toMatch(/quota_exhausted/);
    expect(res.summary).toBe(res.message);
    const plan = events.find((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>;
    expect(plan).toMatchObject({ provider: "claude-cli", usage: { status: "rejected" } });
    // As in the real CLI's reports, the 7-day window (not used up) resets days after the 5-hour one that ran out:
    // the time shown is the 5-hour window's, never the latest one.
    const sevenDay = plan.usage.windows.find((w) => w.id === "seven_day")!;
    expect(sevenDay.utilization).toBeLessThan(1);
    expect(sevenDay.resetsAt! > iso).toBe(true);
    expect(res.message).not.toContain(sevenDay.resetsAt!);
  });
});

describe("optional modules", () => {
  it.skipIf(!existsSync(join(repo, "packages", "mcp-server", "dist", "stdio.js")))("loads the MCP server from the workspace in development", async () => {
    const m = await loadMcpServer(join(repo, "packages", "mcp-server"));
    expect(m).not.toBeNull();
    expect(typeof m!.module.createMcpHost).toBe("function");
    expect(m!.stdio.endsWith(join("dist", "stdio.js"))).toBe(true);
    expect(await loadMcpServer(join(tmp(), "nope"))).toBeNull();
  });

  it("the agent-runtime module is optional (null when the agent package does not ship it)", async () => {
    const m = await loadCliRuntime();
    expect(m === null || typeof m.CliAgentRuntime === "function").toBe(true);
  });
});


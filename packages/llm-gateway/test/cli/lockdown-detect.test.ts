import { mkdirSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commonInstallDirs, compareVersions, loginShellPath, normalizeVersion, nvmBinDirs, parseHelp, resolveBinary, versionInRange } from "../../src/cli/detect.js";
import { tripwire } from "../../src/cli/lockdown.js";
import { CLI_PROVIDERS } from "../../src/cli/registry.js";
import { fakeBinary, fixturePath, makeFakeCli, readFixture, removeDir, tempDir } from "./helpers.js";

const claude = CLI_PROVIDERS.get("claude-cli")!;
const gemini = CLI_PROVIDERS.get("gemini-cli")!;
const codex = CLI_PROVIDERS.get("codex-cli")!;
const opencode = CLI_PROVIDERS.get("opencode")!;
const cursor = CLI_PROVIDERS.get("cursor-agent")!;

describe("help parsing and versions", () => {
  it("parses commander (claude), yargs (gemini, opencode) and clap (codex) help", () => {
    const c = parseHelp([readFixture("help/claude-2.1.260.txt")]);
    for (const f of ["--tools", "--mcp-config", "--strict-mcp-config", "--restricted", "--allowedTools", "--allowed-tools", "-p", "--print", "--json-schema"]) expect(c.flags.has(f), f).toBe(true);
    expect(c.choices?.get("--permission-mode")).toContain("dontAsk");
    expect(c.subcommands.has("auth")).toBe(true);
    expect(c.subcommands.has("mcp")).toBe(true);
    const g = parseHelp([readFixture("help/gemini-0.49.0.txt")]);
    expect(g.choices?.get("--output-format")).toEqual(["text", "json", "stream-json"]);
    expect(g.choices?.get("-o")).toEqual(["text", "json", "stream-json"]);
    expect(g.subcommands.has("mcp")).toBe(true);
    const o = parseHelp([readFixture("help/opencode-run-1.17.10.txt")]);
    expect(o.flags.has("--pure")).toBe(true);
    expect(o.choices?.get("--format")).toEqual(["default", "json"]);
    const x = parseHelp([readFixture("help/codex-exec-0.156.1.synthetic.txt")]);
    for (const f of ["--json", "--output-schema", "--ephemeral", "--strict-config", "-C", "-s", "-c", "-i"]) expect(x.flags.has(f), f).toBe(true);
    expect(x.subcommands.has("resume")).toBe(true);
  });

  it("normalizes and compares versions; `.x` ranges", () => {
    expect(normalizeVersion("2.1.260 (Claude Code)")).toBe("2.1.260");
    expect(normalizeVersion("codex-cli 0.156.1")).toBe("0.156.1");
    expect(normalizeVersion("2026.01.28-fd13201")).toBe("2026.1.28");
    expect(compareVersions("2.1.259", "2.1.260")).toBe(-1);
    expect(compareVersions("0.100.0", "0.49.9")).toBe(1);
    expect(versionInRange("0.49.7", { from: "0.49.0", to: "0.49.x" })).toBe(true);
    expect(versionInRange("0.50.0", { from: "0.49.0", to: "0.49.x" })).toBe(false);
    expect(versionInRange("2.1.260", null)).toBe(false);
  });
});

describe("lockdown reports (§5.5)", () => {
  it("Claude 2.1.260 is verified; a newer build with the same flags is static; missing --tools refuses", () => {
    expect(claude.lockdown(fakeBinary("claude-cli", "2.1.260", ["claude-2.1.260.txt"]))).toMatchObject({ ok: true, level: "verified" });
    expect(claude.lockdown(fakeBinary("claude-cli", "2.1.300", ["claude-2.1.260.txt"]))).toMatchObject({ ok: true, level: "static" });
    const b = fakeBinary("claude-cli", "2.1.300", ["claude-2.1.260.txt"]);
    const flags = new Set(b.help.flags);
    flags.delete("--tools");
    const r = claude.lockdown({ ...b, help: { ...b.help, flags } });
    expect(r).toMatchObject({ ok: false, level: "none" });
    expect(r.checks.find((c) => !c.ok)?.detail).toMatch(/--tools/);
    expect(claude.lockdown(fakeBinary("claude-cli", "2.1.259", ["claude-2.1.260.txt"]))).toMatchObject({ ok: false });
  });

  it("Gemini 0.49.x verified, newer static; opencode 1.17.x verified; Codex static (never run)", () => {
    expect(gemini.lockdown(fakeBinary("gemini-cli", "0.49.0", ["gemini-0.49.0.txt"])).level).toBe("verified");
    expect(gemini.lockdown(fakeBinary("gemini-cli", "0.60.0", ["gemini-0.49.0.txt"])).level).toBe("static");
    expect(opencode.lockdown(fakeBinary("opencode", "1.17.10", ["opencode-run-1.17.10.txt"])).level).toBe("verified");
    expect(opencode.lockdown(fakeBinary("opencode", "1.18.32", ["opencode-run-1.17.10.txt"])).level).toBe("static");
    expect(codex.lockdown(fakeBinary("codex-cli", "0.156.1", ["codex-exec-0.156.1.synthetic.txt"])).level).toBe("static");
  });

  it("Cursor is refused on the installed 2026.01.28 build and even on a build with --trust", () => {
    const installed = cursor.lockdown(fakeBinary("cursor-agent", "2026.1.28", ["cursor-agent-2026.01.28.txt"]));
    expect(installed).toMatchObject({ ok: false, level: "none" });
    expect(installed.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(expect.arrayContaining(["flag:--trust", "blocked"]));
    expect(cursor.lockdown(fakeBinary("cursor-agent", "2026.3.1", ["cursor-agent-trust.synthetic.txt"]))).toMatchObject({ ok: false, level: "none" });
  });
});

describe("tripwires (§5.6)", () => {
  const ctx = { allowed: new Set(["mcp__cad__apply_cadscript"]), structuredToolName: "StructuredOutput", expectMcp: "cad" as const };
  const init = (tools: string[], mcpServers: Array<{ name: string; status: string }>) => ({ type: "init" as const, sessionId: null, model: null, version: null, tools, mcpServers });

  it("init: only our tools (+ StructuredOutput) and exactly the cad server, connected", () => {
    expect(tripwire(init(["mcp__cad__apply_cadscript", "StructuredOutput"], [{ name: "cad", status: "connected" }]), ctx)).toBeNull();
    expect(tripwire(init(["Bash", "mcp__cad__apply_cadscript"], [{ name: "cad", status: "connected" }]), ctx)).toMatchObject({ kind: "unexpected_tool" });
    expect(tripwire(init(["mcp__cad__apply_cadscript"], [{ name: "cad", status: "connected" }, { name: "supabase", status: "connected" }]), ctx)).toMatchObject({ kind: "unexpected_mcp_server" });
    expect(tripwire(init(["mcp__cad__apply_cadscript"], [{ name: "cad", status: "failed" }]), ctx)).toMatchObject({ kind: "mcp_not_connected" });
    expect(tripwire(init([], [{ name: "cad", status: "connected" }]), { ...ctx, expectMcp: "none" })).toMatchObject({ kind: "unexpected_mcp_server" });
  });

  it("every tool call must be in scope", () => {
    const call = (qualifiedName: string, server: string | null) => ({ type: "tool_call" as const, callId: "c", qualifiedName, server, tool: qualifiedName, input: {} });
    expect(tripwire(call("mcp__cad__apply_cadscript", "cad"), ctx)).toBeNull();
    expect(tripwire(call("mcp__cad__delete_everything", "cad"), ctx)).toMatchObject({ kind: "unexpected_tool" });
    expect(tripwire(call("mcp__github__create_issue", "github"), ctx)).toMatchObject({ kind: "unexpected_mcp_server" });
    expect(tripwire(call("WebFetch", null), ctx)).toMatchObject({ kind: "builtin_activity" });
  });
});

describe("binary resolution and detection (fake binaries, no model call)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) removeDir(dir);
    dir = null;
  });

  it("ignores relative PATH entries, prefers PATH over known dirs, honors a Settings override by basename", async () => {
    dir = tempDir();
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    const inB = makeFakeCli(b, "claude", {});
    const env = { PATH: `relative:.:${b}` };
    const r = await resolveBinary(["claude"], { overridePath: null, env, extraDirs: [a], loginShell: false });
    expect(r).toMatchObject({ path: inB, source: "path" });
    const known = await resolveBinary(["claude"], { overridePath: null, env: { PATH: "relative" }, extraDirs: [b], loginShell: false });
    expect(known?.source).toBe("known-dir");
    expect(await resolveBinary(["claude"], { overridePath: join(b, "not-claude"), env, extraDirs: [], loginShell: false })).toBeNull();
    const target = makeFakeCli(a, "claude-real", {});
    symlinkSync(target, join(a, "claude"));
    const viaLink = await resolveBinary(["claude"], { overridePath: join(a, "claude"), env, extraDirs: [], loginShell: false });
    expect(viaLink).toMatchObject({ source: "settings", realPath: target });
    writeFileSync(join(a, "notexec"), "x");
    chmodSync(join(a, "notexec"), 0o644);
  });

  it("finds a CLI installed under nvm from a GUI-launched app's minimal PATH (the default alias first, then newest Node)", async () => {
    dir = tempDir();
    const home = join(dir, "home");
    const versions = join(home, ".nvm", "versions", "node");
    for (const v of ["v18.20.4", "v22.16.0", "v20.19.1", "not-a-version"]) mkdirSync(join(versions, v, "bin"), { recursive: true });
    const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
    expect(nvmBinDirs(env)).toEqual(["v22.16.0", "v20.19.1", "v18.20.4"].map((v) => join(versions, v, "bin")));
    mkdirSync(join(home, ".nvm", "alias"), { recursive: true });
    writeFileSync(join(home, ".nvm", "alias", "default"), "20\n");
    expect(nvmBinDirs(env)[0]).toBe(join(versions, "v20.19.1", "bin"));
    writeFileSync(join(home, ".nvm", "alias", "default"), "lts/*\n");
    expect(nvmBinDirs(env)[0]).toBe(join(versions, "v22.16.0", "bin"));
    // $NVM_DIR wins over ~/.nvm; no nvm at all is no directory.
    expect(nvmBinDirs({ HOME: home, NVM_DIR: join(dir, "elsewhere") })).toEqual([]);
    expect(nvmBinDirs({ HOME: join(dir, "nobody") })).toEqual([]);

    const bin = makeFakeCli(join(versions, "v18.20.4", "bin"), "claude", {});
    expect(commonInstallDirs(env)).toEqual(expect.arrayContaining([join(home, ".local", "bin"), "/opt/homebrew/bin", join(versions, "v18.20.4", "bin")]));
    const r = await resolveBinary(["claude"], { overridePath: null, env, extraDirs: commonInstallDirs(env), loginShell: false });
    expect(r).toMatchObject({ path: bin, source: "known-dir" });
  });

  it("the login-shell lookup falls back to the account's shell when SHELL is missing", () => {
    expect(loginShellPath({ SHELL: "/bin/zsh" })).toBe("/bin/zsh");
    const saved = process.env["SHELL"];
    delete process.env["SHELL"];
    try {
      const shell = loginShellPath({});
      expect(shell).toBe(userInfo().shell ?? undefined);
      if (process.platform !== "win32") expect(shell).toMatch(/^\//);
    } finally {
      if (saved !== undefined) process.env["SHELL"] = saved;
    }
  });

  it("detect(): ready + verified for a fake claude 2.1.260; unsupported below the minimum; blocked when a flag is gone", async () => {
    dir = tempDir();
    const help = fixturePath("help/claude-2.1.260.txt");
    const env = { PATH: dir, HOME: dir };
    makeFakeCli(dir, "claude", { version: "2.1.260 (Claude Code)", help });
    const ok = await claude.detect({ overridePath: null, env, extraDirs: [], loginShell: false });
    expect(ok).toMatchObject({ status: "ready", lockdown: { level: "verified" }, binary: { version: "2.1.260", source: "path" } });
    const auth = await claude.authStatus(ok.binary!, env);
    expect(auth).toMatchObject({ state: "logged_in", method: "claude.ai", plan: "max", billing: "subscription", probe: "command" });
    expect(JSON.stringify(auth)).not.toMatch(/fixture@example|org-fixture/);

    const old = join(dir, "old");
    mkdirSync(old);
    makeFakeCli(old, "claude", { version: "2.1.200 (Claude Code)", help });
    expect((await claude.detect({ overridePath: join(old, "claude"), env, extraDirs: [], loginShell: false })).status).toBe("unsupported_version");

    const stripped = join(dir, "stripped");
    mkdirSync(stripped);
    const helpFile = join(stripped, "help.txt");
    writeFileSync(helpFile, readFixture("help/claude-2.1.260.txt").replace(/--strict-mcp-config/g, "--lenient-mcp"));
    makeFakeCli(stripped, "claude", { version: "2.1.260 (Claude Code)", help: helpFile });
    const blocked = await claude.detect({ overridePath: join(stripped, "claude"), env, extraDirs: [], loginShell: false });
    expect(blocked.status).toBe("blocked");
    expect(blocked.detail).toMatch(/--strict-mcp-config/);
  });

  it("Claude auth mapping: logged out, third-party provider, API key", async () => {
    dir = tempDir();
    const env = { PATH: dir, HOME: dir };
    const help = fixturePath("help/claude-2.1.260.txt");
    const auth = async (a: Record<string, unknown>) => {
      const sub = join(dir!, `c${Math.random().toString(16).slice(2)}`);
      mkdirSync(sub);
      const p = makeFakeCli(sub, "claude", { help, auth: a });
      const d = await claude.detect({ overridePath: p, env, extraDirs: [], loginShell: false });
      return claude.authStatus(d.binary!, env);
    };
    expect((await auth({ loggedIn: false })).state).toBe("logged_out");
    expect(await auth({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" })).toMatchObject({ state: "unknown", billing: "metered" });
    expect(await auth({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })).toMatchObject({ state: "logged_in", billing: "metered", plan: null });
  });
});

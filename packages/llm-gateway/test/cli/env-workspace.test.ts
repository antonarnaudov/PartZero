import { existsSync, lstatSync, mkdirSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliChildEnv, secretValues } from "../../src/cli/env.js";
import { createCliWorkspace, sweepCliWorkspaces } from "../../src/cli/workspace.js";
import { removeDir, tempDir } from "./helpers.js";

describe("cliChildEnv (allowlist, deny pattern, forced values)", () => {
  const parent = {
    PATH: "/usr/bin:relative/bin:.:/bin",
    HOME: "/home/u",
    USER: "u",
    LANG: "en_US.UTF-8",
    CLAUDE_CONFIG_DIR: "/home/u/.claude-alt",
    HTTPS_PROXY: "http://user:secret@proxy:8080",
    ANTHROPIC_API_KEY: "sk-ant-should-never-pass",
    OPENAI_API_KEY: "sk-nope",
    GEMINI_API_KEY: "AIza-nope",
    GEMINI_CLI_HOME: "/home/u/gem",
    GITHUB_TOKEN: "ghp_nope",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_MESSAGING_TOKEN: "nope",
    CI: "true",
    GITHUB_ACTIONS: "true",
    NODE_OPTIONS: "--require /evil.js",
    ELECTRON_RUN_AS_NODE: "1",
    SOME_RANDOM_VAR: "x",
    XDG_CONFIG_HOME: "/home/u/.config",
    CODEX_API_KEY: "nope",
    CURSOR_API_KEY: "nope",
  };
  const env = cliChildEnv(parent, { tmpDir: "/ws/.tmp", binaryDir: "/opt/claude/bin", nodeDir: "/opt/node/bin", extra: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", AICAD_MCP_TICKET: "t".repeat(64) } });

  it("keeps only allowlisted names and never a credential", () => {
    expect(Object.keys(env).sort()).toEqual(
      [
        "AICAD_MCP_TICKET",
        "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
        "CLAUDE_CONFIG_DIR",
        "FORCE_COLOR",
        "GEMINI_CLI_HOME",
        "HOME",
        "HTTPS_PROXY",
        "LANG",
        "NO_BROWSER",
        "NO_COLOR",
        "NO_OPEN_BROWSER",
        "PATH",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        "USER",
        "XDG_CONFIG_HOME",
      ].sort(),
    );
    for (const v of Object.values(env)) expect(v).not.toMatch(/sk-|AIza|ghp_|--require/);
  });

  it("forces TMPDIR/colors/browser and orders PATH: binary dir, node dir, absolute host entries", () => {
    expect(env["TMPDIR"]).toBe("/ws/.tmp");
    expect(env["TEMP"]).toBe("/ws/.tmp");
    expect(env["NO_COLOR"]).toBe("1");
    expect(env["TERM"]).toBe("dumb");
    expect(env["NO_BROWSER"]).toBe("true");
    expect(env["PATH"]).toBe("/opt/claude/bin:/opt/node/bin:/usr/bin:/bin");
  });

  it("provider extras are the only way CLAUDE_CODE_* / AICAD_MCP_* enter", () => {
    expect(env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"]).toBe("1");
    expect(env["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined();
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["CI"]).toBeUndefined();
    expect(env["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
  });

  it("secretValues covers the ticket and proxy settings (for log scrubbing)", () => {
    expect(secretValues(env)).toEqual(expect.arrayContaining(["t".repeat(64), "http://user:secret@proxy:8080"]));
  });
});

describe("CliWorkspace", () => {
  let root: string | null = null;
  afterEach(() => {
    if (root !== null) removeDir(root);
    root = null;
  });

  it("is a fresh 0700 dir with a .tmp and a short socket dir; files are 0400; dispose removes everything", async () => {
    root = tempDir();
    const ws = await createCliWorkspace({ root: join(root, "aicad-cli"), runId: "r1" });
    expect(statSync(ws.dir).mode & 0o777).toBe(0o700);
    expect(statSync(ws.socketDir).mode & 0o777).toBe(0o700);
    expect(existsSync(ws.tmp)).toBe(true);
    expect(join(ws.socketDir, "b.sock").length).toBeLessThanOrEqual(103 + (root.length > 60 ? root.length : 0));
    const p = ws.write("sub/system.md", "hello");
    expect(statSync(p).mode & 0o777).toBe(0o400);
    const img = ws.write("img-1.png", Buffer.from([1, 2, 3]).toString("base64"), 0o400, "base64");
    expect(statSync(img).size).toBe(3);
    await ws.dispose();
    expect(existsSync(ws.dir)).toBe(false);
    expect(existsSync(ws.socketDir)).toBe(false);
  });

  it("refuses '..', absolute paths, overwrites and symlinked directories", async () => {
    root = tempDir();
    const ws = await createCliWorkspace({ root: join(root, "aicad-cli"), runId: "r2", basename: "aicad-run" });
    expect(ws.dir.endsWith("/aicad-run")).toBe(true);
    expect(() => ws.write("../x", "a")).toThrow(/refusing/);
    expect(() => ws.write("/etc/x", "a")).toThrow(/refusing/);
    ws.write("a.txt", "1");
    expect(() => ws.write("a.txt", "2")).toThrow();
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(ws.dir, "link"));
    expect(lstatSync(join(ws.dir, "link")).isSymbolicLink()).toBe(true);
    expect(() => ws.write("link/x.txt", "a")).toThrow(/symlink/);
    await ws.dispose();
  });

  it("the startup sweep removes workspaces older than 24 h", async () => {
    root = tempDir();
    const r = join(root, "aicad-cli");
    const old = await createCliWorkspace({ root: r, runId: "old", keep: true });
    const fresh = await createCliWorkspace({ root: r, runId: "new" });
    const holder = join(old.dir, "..");
    const past = (Date.now() - 25 * 3600 * 1000) / 1000;
    utimesSync(holder, past, past);
    expect(await sweepCliWorkspaces(r)).toBeGreaterThanOrEqual(1);
    expect(existsSync(old.dir)).toBe(false);
    expect(existsSync(fresh.dir)).toBe(true);
    await fresh.dispose();
  });
});

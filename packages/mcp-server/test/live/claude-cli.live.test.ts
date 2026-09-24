/**
 * Live smoke: headless Claude Code drives the `cad` MCP server in runtime mode (CLI-PROVIDERS.md §4.2,
 * §13.2). Opt-in only, because it spends the owner's plan:
 *
 *   AICAD_LIVE_CLI=claude pnpm --filter @aicad/mcp-server test:live:cli
 *
 * One CLI invocation (Haiku, ≤ 6 turns, two user messages over stdin stream-json). Never in CI.
 * With AICAD_RECORD_FIXTURES=claude it also records the scrubbed stream, the MCP frames Claude sent and
 * the broker log into test/fixtures (review them before committing).
 *
 * The owner's credentials are never read: the CLI uses its own login. The child environment is an
 * allowlist (no API keys, no CLAUDE_CODE_* from a parent Claude Code session).
 *
 * Claude Code 2.1.260 opens a cross-session messaging socket (when its server-side gate is on) at
 * `$XDG_RUNTIME_DIR` or `$CLAUDE_CODE_TMPDIR` (default `/tmp`) + `/cc-socks/<pid>.sock`; `TMPDIR` is
 * ignored. The run sets `CLAUDE_CODE_TMPDIR` to the workspace's private temp dir, and the test asserts
 * the socket stays inside it.
 */
import { spawn, execFileSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { designRegistry, DesignSession } from "@aicad/agent-tools";
import { createMcpHost } from "../../src/broker.js";
import { sessionToolHandler } from "../../src/host/session-handler.js";
import { LineSplitter } from "../../src/jsonrpc.js";
import { registryToolDefs, scopeToolNames } from "../../src/scopes.js";
import { Scrubber } from "../helpers/scrub.js";
import { disc, StubEngine } from "../helpers/stub-engine.js";
import { PKG_DIR, SHIM } from "../helpers/util.js";

const LIVE_CLI = new Set((process.env["AICAD_LIVE_CLI"] ?? "").split(",").filter(Boolean));
const RECORD = process.env["AICAD_RECORD_FIXTURES"] === "claude";
/** Optional diagnostics file (e.g. where the messaging socket went); nothing secret is written to it. */
const DIAG = process.env["AICAD_LIVE_DIAG"];
const FIXTURES = join(PKG_DIR, "test", "fixtures");

/** `claude` on PATH: absolute entries only, real path (L11). */
function findClaude(): string | null {
  for (const d of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!isAbsolute(d)) continue;
    const p = join(d, "claude");
    try {
      accessSync(p, constants.X_OK);
      return realpathSync(p);
    } catch {
      // next
    }
  }
  return null;
}

function childEnv(bin: string, tmp: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["HOME", "USER", "LOGNAME", "LANG"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  const hostPath = (process.env["PATH"] ?? "").split(delimiter).filter((d) => isAbsolute(d));
  env["PATH"] = [dirname(bin), ...hostPath].join(delimiter);
  // CLAUDE_CODE_TMPDIR: Claude's own temp root (messaging socket, screenshots); it ignores TMPDIR.
  Object.assign(env, { TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", MCP_TOOL_TIMEOUT: "900000" }, extra);
  return env;
}

const userMessage = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

describe.skipIf(!LIVE_CLI.has("claude"))("claude-cli live: runtime mode through aicad-mcp", () => {
  it("lists only our tools, calls them through the broker, and continues over stdin stream-json", { timeout: 240_000 }, async () => {
    const bin = findClaude();
    if (!bin) throw new Error("claude is not on PATH");
    const version = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    expect(version).toMatch(/^2\.1\.\d+ \(Claude Code\)$/);
    expect(existsSync(SHIM)).toBe(true);

    const root = realpathSync(mkdtempSync(join(tmpdir(), "aicad-live-")));
    const ws = join(root, "w");
    const tmp = join(ws, ".tmp");
    const tee = join(root, "mcp-frames.jsonl");
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const session = await DesignSession.open({ engine: new StubEngine(), source: disc(5, 5), name: "live" });
    const registry = designRegistry();
    const names = scopeToolNames("read");
    const shim = RECORD
      ? { command: process.execPath, args: [join(PKG_DIR, "test", "helpers", "tee-shim.mjs"), SHIM], env: { AICAD_MCP_TEE: tee } }
      : { command: process.execPath, args: [SHIM], env: {} };
    const mcp = await createMcpHost({ shim }).open({
      dir: join(root, "s"),
      scope: "read",
      tools: registryToolDefs(registry, names),
      instructions: "CAD tools for one part. Use only these tools.",
      handler: sessionToolHandler({ session, registry: registry.subset(names) }),
    });
    const a = mcp.attachment;
    const w = (name: string, content: string) => writeFileSync(join(ws, name), content, { mode: 0o400 });
    w("claude-settings.json", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }));
    w("mcp.json", JSON.stringify({ mcpServers: { cad: { type: "stdio", command: a.command, args: a.args, env: a.env } } }));
    w("system.md", "You are a CAD assistant. You have only the cad tools. Follow the user's instructions exactly and reply in as few words as possible.");
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--model", "haiku",
      "--restricted", "--disable-slash-commands", "--settings", join(ws, "claude-settings.json"),
      "--tools", "", "--strict-mcp-config", "--mcp-config", join(ws, "mcp.json"),
      "--permission-mode", "dontAsk", "--allowedTools", "mcp__cad",
      "--no-session-persistence", "--max-turns", "6",
      "--system-prompt-file", join(ws, "system.md"),
    ];
    expect(args.join(" ")).not.toContain(mcp.ticket);
    const child = spawn(bin, args, { cwd: ws, env: childEnv(bin, tmp, { AICAD_MCP_TICKET: mcp.ticket }), stdio: ["pipe", "pipe", "pipe"], detached: true });
    const lines: string[] = [];
    const events: Record<string, unknown>[] = [];
    let stderr = "";
    let results = 0;
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-8192)));
    const splitter = new LineSplitter((line) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      lines.push(line);
      events.push(e);
      if (e["type"] === "result") {
        results++;
        if (results === 1) child.stdin.write(userMessage("Now call ir_summary once and reply with only the number of features it lists."));
        else child.stdin.end();
      }
    }, () => undefined);
    child.stdout.on("data", (c: Buffer) => splitter.push(c));
    const killer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // gone
      }
    }, 200_000);
    child.stdin.write(userMessage("Call the get_code tool once. Then reply with only the number of lines it reports."));
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    clearTimeout(killer);
    const log = mcp.log();
    await mcp.dispose();

    try {
      if (RECORD) {
        const scrub = new Scrubber(
          [
            [root, "<root>"],
            [homedir(), "<home>"],
          ],
          [mcp.ticket],
        );
        writeFileSync(join(FIXTURES, "cli", "claude", "runtime-read-2.1.260.jsonl"), lines.map((l) => scrub.line(l)).join("\n") + "\n");
        const frames = readFileSync(tee, "utf8").split("\n").filter((l) => l.trim() !== "");
        const header = { _fixture: { client: "claude-code", cliVersion: version.split(" ")[0], evidence: `recorded ${new Date().toISOString().slice(0, 10)} from a live \`claude -p\` runtime-mode run (Haiku) through aicad-mcp (test/live/claude-cli.live.test.ts); scrubbed`, mode: "runtime, read scope" } };
        writeFileSync(join(FIXTURES, "clients", "claude-code-2.1.260.jsonl"), [JSON.stringify(header), ...frames.map((l) => scrub.line(l))].join("\n") + "\n");
        writeFileSync(
          join(FIXTURES, "cli", "claude", "runtime-read-2.1.260.broker.json"),
          JSON.stringify(scrub.value({ scope: "read", tools: a.toolNames, calls: log.map(({ seq, name, isError, text }) => ({ seq, name, isError, text })) }), null, 1) + "\n",
        );
      }
      expect({ code, stderrTail: code === 0 ? "" : stderr.slice(-2000) }).toEqual({ code: 0, stderrTail: "" });
      // Tripwire (CLI-PROVIDERS.md §5.6), on every init (Claude sends one per user message): the model's
      // toolset is exactly our scope, only our server is connected, and the subscription login is used.
      const inits = events.filter((e) => e["type"] === "system" && e["subtype"] === "init");
      expect(inits.length).toBeGreaterThanOrEqual(2);
      for (const init of inits) {
        expect([...(init["tools"] as string[])].sort()).toEqual(names.map((n) => `mcp__cad__${n}`).sort());
        expect(init["mcp_servers"]).toEqual([{ name: "cad", status: "connected" }]);
        expect(init["apiKeySource"]).toBe("none");
        // The cross-session messaging socket (if the CLI opened one) stays in the private workspace temp dir.
        const sock = init["messaging_socket_path"];
        if (DIAG) appendFileSync(DIAG, `init: messaging socket ${typeof sock === "string" && sock !== "" ? sock.split(root).join("<root>") : "none"}\n`);
        if (sock !== undefined && sock !== null && sock !== "") expect(String(sock).startsWith(`${tmp}/`), `messaging socket at ${String(sock)}`).toBe(true);
      }
      const toolUses = events
        .filter((e) => e["type"] === "assistant")
        .flatMap((e) => ((e["message"] as { content: { type: string; name?: string }[] }).content ?? []).filter((b) => b.type === "tool_use"));
      expect(toolUses.length).toBeGreaterThanOrEqual(2);
      for (const t of toolUses) expect(t.name).toMatch(/^mcp__cad__(get_code|ir_summary|measure|run_tests)$/);
      expect(log.map((l) => l.name)).toEqual(expect.arrayContaining(["get_code", "ir_summary"]));
      const resultEvents = events.filter((e) => e["type"] === "result");
      expect(resultEvents.map((r) => r["subtype"])).toEqual(["success", "success"]);
      expect(lines.join("\n")).not.toContain(mcp.ticket);

    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

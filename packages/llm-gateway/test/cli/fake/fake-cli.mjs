// Fake CLI for offline tests. Generated wrappers (see test/cli/helpers.ts `makeFakeCli`) call `main(scenario)`.
// It never touches the network or any real CLI state. Behaviours:
//   --version / --help / auth status: print scenario strings.
//   mode "replay": print the fixture JSONL (optionally with a delay), stderr text, exit code.
//   mode "hang" | "silent" | "stall": print one line (or none) and never exit on its own.
//   mode "huge": print lines longer than 1 MiB.   mode "nonjson": print many non-JSON lines.
//   mode "grandchild": fork a child that ignores SIGTERM-less shutdown, report its pid, then hang.
//   mode "ignore-term": ignore SIGTERM and hang (needs SIGKILL).
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 2_000).unref();
  });
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, `${prefix}${name}/`));
    else out.push({ path: `${prefix}${name}`, mode: st.mode & 0o777, size: st.size });
  }
  return out;
}

const hang = () => setInterval(() => {}, 1_000);

export async function main(s) {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v") && argv.length === 1) {
    process.stdout.write(`${s.version ?? "2.1.260 (Claude Code)"}\n`);
    return;
  }
  if (argv.includes("--help")) {
    process.stdout.write(s.help === undefined ? "" : readFileSync(s.help, "utf8"));
    return;
  }
  if (argv[0] === "auth" && argv[1] === "status") {
    process.stdout.write(`${JSON.stringify(s.auth ?? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "fixture@example.invalid", orgId: "org-fixture" })}\n`);
    return;
  }
  // Session cleanup commands (gemini --delete-session, opencode session delete, codex delete): record and exit.
  if (argv.some((a) => a === "--delete-session" || a.startsWith("--delete-session=")) || (argv[0] === "session" && argv[1] === "delete") || argv[0] === "delete") {
    if (s.record !== undefined) writeFileSync(`${s.record}.cleanup`, JSON.stringify({ argv, cwd: process.cwd(), ticket: process.env.AICAD_MCP_TICKET ?? null }));
    return;
  }
  const stdin = s.mode === "grandchild" || s.mode === "ignore-term" || s.mode === "silent" ? "" : await readStdin();
  if (s.record !== undefined) {
    const settings = (() => {
      try {
        return readFileSync(join(process.cwd(), ".gemini", "settings.json"), "utf8");
      } catch {
        return null;
      }
    })();
    writeFileSync(s.record, JSON.stringify({ argv, env: process.env, cwd: process.cwd(), stdin, files: listFiles(process.cwd()), geminiSettings: settings }));
  }
  const mode = s.mode ?? "replay";
  if (s.stderr !== undefined) process.stderr.write(s.stderr);
  if (mode === "replay") {
    let fixture = s.fixture;
    if (Array.isArray(s.fixtures) && s.stateFile !== undefined) {
      // One fixture per invocation, in order (e.g. an invalid reply, then the repaired one).
      let n = 0;
      try {
        n = Number(readFileSync(s.stateFile, "utf8")) || 0;
      } catch {}
      writeFileSync(s.stateFile, String(n + 1));
      fixture = s.fixtures[Math.min(n, s.fixtures.length - 1)];
    }
    const lines = fixture === undefined ? [] : readFileSync(fixture, "utf8").split("\n").filter((l) => l.length > 0);
    for (const l of lines) {
      process.stdout.write(`${l}\n`);
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    }
    process.exitCode = s.exitCode ?? 0;
    return;
  }
  if (mode === "huge") {
    const big = `{"type":"x","pad":"${"a".repeat((1 << 20) + 16)}"}`;
    for (let i = 0; i < 5; i++) process.stdout.write(`${big}\n`);
    return;
  }
  if (mode === "nonjson") {
    for (let i = 0; i < 150; i++) process.stdout.write(`progress ${i}\n`);
    return;
  }
  if (mode === "stall") {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"s","tools":[],"mcp_servers":[],"model":"m"}\n');
    hang();
    return;
  }
  if (mode === "silent") {
    hang();
    return;
  }
  if (mode === "ignore-term") {
    process.on("SIGTERM", () => {});
    process.stdout.write('{"type":"system","subtype":"init","session_id":"s","tools":[],"mcp_servers":[],"model":"m"}\n');
    hang();
    return;
  }
  if (mode === "grandchild") {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], { stdio: "ignore" });
    if (s.pidFile !== undefined) writeFileSync(s.pidFile, String(child.pid));
    process.stdout.write('{"type":"system","subtype":"init","session_id":"s","tools":[],"mcp_servers":[],"model":"m"}\n');
    hang();
    return;
  }
  if (mode === "hang") {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"s","tools":[],"mcp_servers":[],"model":"m"}\n');
    const t = setInterval(() => process.stdout.write('{"type":"system","subtype":"thinking_tokens","estimated_tokens":1}\n'), 20);
    void t;
  }
}

// A fake Claude Code (`claude -p`) for offline agent-runtime tests (docs/CLI-PROVIDERS.md §13.1 "Fake CLI").
//
// Generated wrappers (test/cli-harness.ts) call `main(<scenario.json path>)`. It never touches the network or
// any real CLI state, and it records only what the tests assert on (argv, env NAMES, the system prompt, tool
// results) into the scenario's `recordDir`. It never writes the MCP ticket anywhere.
//
//   --version / --help / auth status --json: fixed Claude Code 2.1.260 answers (the help lists the lockdown flags).
//   completion (--input-format text): the role is read from the system prompt's tool list; the next scripted
//     envelope for that role is returned as StructuredOutput (--json-schema) or as JSON text (text-json).
//   runtime (--input-format stream-json): launches the `cad` MCP server from --mcp-config exactly as Claude
//     does (it inherits this process's environment, so the shim gets AICAD_MCP_TICKET), does the MCP handshake,
//     emits `system/init` with `mcp__cad__*` tools, then plays one scripted CLI turn per stdin user message,
//     making REAL `tools/call` requests through the shim and the host broker. Exits on stdin EOF.
//   runtime replay (`runtime.<phase>.replay: <recorded stream-json>`): re-emits a recorded (scrubbed) Claude Code
//     stream, one `result`-terminated segment per stdin user message, but performs every recorded `mcp__cad__*`
//     tool_use as a REAL MCP call and substitutes the recorded tool_result with the real answer.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const HELP = `Usage: claude [options] [command] [prompt]

Claude Code (fake for tests).

Options:
  -p, --print                           Print response and exit
  --output-format <format>              Output format (choices: "text", "json", "stream-json")
  --input-format <format>               Input format (choices: "text", "stream-json")
  --verbose                             Verbose output
  --model <model>                       Model for the session
  --effort <level>                      Effort level (low, medium, high, xhigh, max)
  --tools <tools...>                    Built-in tools to enable
  --mcp-config <configs...>             Load MCP servers from JSON files
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --restricted                          Restricted mode
  --disable-slash-commands              Disable slash commands
  --no-session-persistence              Do not save sessions
  --allowedTools, --allowed-tools <tools...>  Tools to allow
  --permission-mode <mode>              Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")
  --json-schema <schema>                JSON Schema for structured output
  --settings <file-or-json>             Settings file or JSON
  --max-budget-usd <amount>             Maximum dollar amount to spend
`;

const MODEL = "claude-haiku-4-5-20251001";
const SESSION = "00000000-0000-4000-8000-00000000fa4e";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq === undefined ? undefined : eq.slice(name.length + 1);
}

function readAll(stream) {
  return new Promise((resolve) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data));
    stream.on("error", () => resolve(data));
  });
}

/** Per-role counters across invocations (completion mode is one process per call). */
function nextIndex(stateFile, role) {
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {}
  const n = state[role] ?? 0;
  state[role] = n + 1;
  writeFileSync(stateFile, JSON.stringify(state));
  return n;
}

export async function main(scenarioPath) {
  const s = JSON.parse(readFileSync(scenarioPath, "utf8"));
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) return void process.stdout.write(`${s.version ?? "2.1.260 (Claude Code)"}\n`);
  if (argv.includes("--help")) return void process.stdout.write(HELP);
  if (argv[0] === "auth") return void out({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" });

  const record = (file, o) => appendFileSync(join(s.recordDir, file), `${JSON.stringify(o)}\n`);
  const systemFile = flag(argv, "--system-prompt-file");
  const system = systemFile === undefined ? "" : readFileSync(systemFile, "utf8");
  const runtime = flag(argv, "--input-format") === "stream-json";
  record("invocations.jsonl", {
    pid: process.pid,
    mode: runtime ? "runtime" : "completion",
    argv,
    cwd: process.cwd(),
    envNames: Object.keys(process.env).sort(),
    tmpdir: process.env.TMPDIR ?? null,
    claudeTmp: process.env.CLAUDE_CODE_TMPDIR ?? null,
    hasTicket: typeof process.env.AICAD_MCP_TICKET === "string" && process.env.AICAD_MCP_TICKET.length > 0,
    system,
  });
  if (runtime) return runRuntime(s, argv, record);
  return runCompletion(s, argv, system, record);
}

// ── completion mode ──────────────────────────────────────────────────────────────────────────────

async function runCompletion(s, argv, system, record) {
  const stdin = await readAll(process.stdin);
  const schema = flag(argv, "--json-schema");
  const role = /^## classify$/m.test(system) ? "triage" : /^## submit_spec$/m.test(system) ? "spec_writer" : /^## apply_cadscript$/m.test(system) ? "designer" : "plain";
  const list = s.completion?.[role] ?? [];
  const n = nextIndex(join(s.recordDir, "completion-state.json"), role);
  const reply = list[Math.min(n, list.length - 1)] ?? { text: "", tool_calls: [] };
  record("completion.jsonl", { role, n, via: schema === undefined ? "text" : "json-schema", stdin });
  out({ type: "system", subtype: "init", session_id: SESSION, tools: schema === undefined ? [] : ["StructuredOutput"], mcp_servers: [], model: MODEL, claude_code_version: "2.1.260", apiKeySource: "none" });
  const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const text = role === "plain" ? String(reply.text ?? reply) : JSON.stringify(reply);
  if (schema !== undefined) {
    out({ type: "assistant", message: { model: MODEL, id: "msg_c1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_c1", name: "StructuredOutput", input: reply }], stop_reason: null, usage } });
  } else {
    out({ type: "assistant", message: { model: MODEL, id: "msg_c1", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: null, usage } });
  }
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    session_id: SESSION,
    total_cost_usd: 0.0016,
    usage,
    modelUsage: { [MODEL]: { inputTokens: 1200, outputTokens: 80, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0016, costBasis: "list" } },
    result: schema === undefined ? text : "",
    ...(schema === undefined ? {} : { structured_output: reply }),
    stop_reason: "end_turn",
  });
}

// ── runtime mode ─────────────────────────────────────────────────────────────────────────────────

async function startMcp(cad) {
  const child = spawn(cad.command, cad.args ?? [], { env: { ...process.env, ...(cad.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 0;
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const done = pending.get(msg.id);
      if (done) {
        pending.delete(msg.id);
        done(msg);
      }
    }
  });
  child.stderr.on("data", () => {});
  child.on("exit", () => {
    for (const done of pending.values()) done({ error: { code: -1, message: "the MCP server exited" } });
    pending.clear();
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  const init = await Promise.race([request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.260" } }), sleep(10_000).then(() => null)]);
  if (init === null || init.error) return { ok: false, pid: child.pid, tools: [], call: async () => ({ text: "not connected", isError: true }), close: () => child.kill() };
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await request("tools/list");
  const tools = (list.result?.tools ?? []).map((t) => t.name);
  return {
    ok: true,
    pid: child.pid,
    tools,
    async call(name, args, toolUseId) {
      const r = await request("tools/call", { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId, progressToken: nextId } });
      if (r.error) return { text: `MCP error ${r.error.code}: ${r.error.message}`, isError: true };
      return { text: (r.result?.content ?? []).map((c) => c.text ?? "").join(""), isError: r.result?.isError === true };
    },
    close() {
      child.stdin.end();
    },
  };
}

async function runRuntime(s, argv, record) {
  const config = JSON.parse(readFileSync(flag(argv, "--mcp-config"), "utf8"));
  const cad = config.mcpServers?.cad;
  const mcp = cad === undefined ? null : await startMcp(cad);
  const tools = mcp?.tools ?? [];
  const phase = tools.includes("submit_spec") ? "spec" : tools.includes("apply_cadscript") ? "build" : "ask";
  const script = s.runtime?.[phase] ?? { turns: [] };
  const maxTurns = Number(flag(argv, "--max-turns") ?? "0");
  const price = s.pricing ?? { input: 1, output: 5 }; // $/MTok (Haiku list price)
  record("phases.jsonl", { phase, pid: process.pid, mcpPid: mcp?.pid ?? null, tools });
  out({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: SESSION,
    tools: [...tools.map((t) => `mcp__cad__${t}`), ...(script.extraTools ?? [])],
    mcp_servers: mcp === null ? [] : [{ name: "cad", status: mcp.ok ? "connected" : "failed" }],
    model: MODEL,
    permissionMode: "dontAsk",
    apiKeySource: "none",
    claude_code_version: "2.1.260",
    plugins: [],
    skills: [],
    slash_commands: [],
  });
  if (script.planUsage !== undefined) out({ type: "rate_limit_event", rate_limit_info: script.planUsage });

  let msgN = 0;
  let callN = 0;
  let totalTurns = 0;
  const totals = { in: 0, out: 0 };
  const cost = () => (totals.in * price.input + totals.out * price.output) / 1e6;

  let runTurn = async (index, userText) => {
    record("turns.jsonl", { phase, index, user: userText });
    const msgs = script.turns?.[index] ?? [{ text: "(no scripted turn)" }];
    let numTurns = 0;
    let lastText = "";
    let perTurn = { in: 0, out: 0 };
    for (const m of msgs) {
      if (m.sleepMs) await sleep(m.sleepMs);
      if (m.hang) await new Promise(() => {});
      if (m.raw) {
        out(m.raw);
        continue;
      }
      const id = `msg_${++msgN}`;
      const usage = { input_tokens: m.usage?.input ?? 1000, output_tokens: m.usage?.output ?? 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      totals.in += usage.input_tokens;
      totals.out += usage.output_tokens;
      perTurn = { in: perTurn.in + usage.input_tokens, out: perTurn.out + usage.output_tokens };
      numTurns++;
      totalTurns++;
      const base = { model: MODEL, id, type: "message", role: "assistant", stop_reason: null, usage };
      if (m.text !== undefined) {
        out({ type: "assistant", message: { ...base, content: [{ type: "text", text: m.text }] } });
        if ((m.calls ?? []).length === 0) lastText = m.text;
      }
      const calls = (m.calls ?? []).map((c) => ({ ...c, toolUseId: `toolu_${++callN}` }));
      for (const c of calls) {
        const name = c.name.includes("__") || c.bare === true ? c.name : `mcp__cad__${c.name}`;
        out({ type: "assistant", message: { ...base, content: [{ type: "tool_use", id: c.toolUseId, name, input: c.args ?? {} }] } });
      }
      if (maxTurns > 0 && numTurns > maxTurns) {
        out({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: numTurns, session_id: SESSION, total_cost_usd: cost(), result: "" });
        return;
      }
      for (const c of calls) {
        const r = mcp === null ? { text: "no MCP server", isError: true } : await mcp.call(c.name, c.args ?? {}, c.toolUseId);
        record("calls.jsonl", { phase, index, name: c.name, isError: r.isError, text: r.text });
        out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: c.toolUseId, content: [{ type: "text", text: r.text }], ...(r.isError ? { is_error: true } : {}) }] }, session_id: SESSION });
      }
    }
    const total = cost();
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: numTurns,
      session_id: SESSION,
      total_cost_usd: total,
      usage: { input_tokens: perTurn.in, output_tokens: perTurn.out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { [MODEL]: { inputTokens: totals.in, outputTokens: totals.out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: total, costBasis: "list" } },
      result: lastText,
      stop_reason: script.resultStop?.[index] ?? "end_turn",
      terminal_reason: "completed",
    });
  };

  if (script.replay !== undefined) {
    const lines = readFileSync(script.replay, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l))
      .filter((o) => o._fixture === undefined);
    const segments = [[]];
    for (const o of lines) {
      segments[segments.length - 1].push(o);
      if (o.type === "result") segments.push([]);
    }
    const initLine = { type: "system", subtype: "init", cwd: process.cwd(), session_id: SESSION, tools: tools.map((t) => `mcp__cad__${t}`), mcp_servers: mcp === null ? [] : [{ name: "cad", status: mcp.ok ? "connected" : "failed" }], model: MODEL, apiKeySource: "none", claude_code_version: "2.1.260" };
    runTurn = async (index, userText) => {
      record("turns.jsonl", { phase, index, user: userText });
      const answers = new Map();
      for (const o of segments[index] ?? []) {
        if (o.type === "system" && o.subtype === "init") {
          if (index > 0) out(initLine); // Claude re-announces itself on every user message
          continue;
        }
        if (o.type === "assistant") {
          out(o);
          for (const b of o.message?.content ?? []) {
            if (b.type !== "tool_use" || typeof b.name !== "string" || !b.name.startsWith("mcp__cad__")) continue;
            const name = b.name.slice("mcp__cad__".length);
            const r = await mcp.call(name, b.input ?? {}, b.id);
            record("calls.jsonl", { phase, index, name, isError: r.isError, text: r.text });
            answers.set(b.id, r);
          }
          continue;
        }
        if (o.type === "user") {
          const content = (o.message?.content ?? []).map((b) => {
            const r = b.type === "tool_result" ? answers.get(b.tool_use_id) : undefined;
            if (r === undefined) return b;
            const { is_error: _e, ...rest } = b;
            return { ...rest, content: [{ type: "text", text: r.text }], ...(r.isError ? { is_error: true } : {}) };
          });
          out({ ...o, message: { ...o.message, content } });
          continue;
        }
        out(o);
      }
    };
  }

  // `exitAfterTurn` + `--resume <id>` imitate the resume-style CLIs (Gemini, Codex, opencode): one process per
  // turn, continued by a new process; the turn index carries over through a state file.
  const stateFile = join(s.recordDir, "runtime-turns.json");
  const readState = () => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {
      return {};
    }
  };
  if (argv.includes("--resume")) record("resumes.jsonl", { phase, sessionId: flag(argv, "--resume"), pid: process.pid });
  let chain = Promise.resolve();
  let index = argv.includes("--resume") ? (readState()[phase] ?? 0) : 0;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let text = "";
    try {
      const msg = JSON.parse(line);
      text = (msg.message?.content ?? []).map((b) => b.text ?? "").join("");
    } catch {}
    const i = index++;
    chain = chain.then(async () => {
      await runTurn(i, text);
      writeFileSync(stateFile, JSON.stringify({ ...readState(), [phase]: i + 1 }));
      if (script.exitAfterTurn === true) {
        mcp?.close();
        setTimeout(() => process.exit(0), 50);
      }
    });
  });
  rl.on("close", () => {
    void chain.then(() => {
      mcp?.close();
      setTimeout(() => process.exit(0), 50);
    });
  });
}

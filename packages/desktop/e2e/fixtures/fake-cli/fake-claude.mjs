// A fake `claude` (Claude Code 2.1.260) for the keyless desktop tests: it never touches the network or any real CLI
// state, and it never needs an API key or a login. `makeFakeClaude()` (../../fake-cli.ts) writes a small `claude`
// wrapper that calls `main(scenario)`.
//
// It answers exactly what the app runs:
//   --version                      "2.1.260 (Claude Code)"
//   --help                         the recorded `claude --help` of 2.1.260 (claude-2.1.260-help.txt)
//   auth status --json             logged in with a Max plan, or logged out (the scenario's state file, read per call)
//   -p … --json-schema <schema>    one completion turn in the stream-json shape recorded from the real CLI
//                                  (llm-gateway test/cli/fixtures/claude/completion-json-schema.jsonl): init, a
//                                  rate_limit_event, the StructuredOutput tool_use carrying the turn envelope, its
//                                  tool_result, a closing text, and the result with `structured_output`.
//
// The envelope comes from a script of `@aicad/agent` ScriptTurns per role (the same file the scripted transport
// replays): the role is read from the tool names in --json-schema (`classify` = triage, `submit_spec` = spec writer,
// otherwise designer), the turn from the number of assistant blocks in the stdin transcript. Every invocation is
// recorded (argv, cwd, the environment's variable NAMES, stdin size and whether the prompt was in argv) so tests can
// check the lockdown the app applied.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSION = "00000000-0000-4000-8000-00000000f4c3";
const MODELS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5-20251001", fable: "claude-fable-5-1" };

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { loggedIn: true, plan: "max" };
  }
}

function flag(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] ?? null;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

/** Tool names in the envelope schema: tool_calls.items.anyOf[].properties.name.enum[0]. */
function toolNames(schema) {
  const items = schema?.properties?.tool_calls?.items;
  const branches = items?.anyOf ?? (items ? [items] : []);
  return branches.map((b) => b?.properties?.name?.enum?.[0]).filter((n) => typeof n === "string");
}

const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main(s) {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) {
    process.stdout.write(`${s.version ?? "2.1.260 (Claude Code)"}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(readFileSync(s.help, "utf8"));
    return;
  }
  const state = readState(s.state);
  if (argv[0] === "auth" && argv[1] === "status") {
    // The real output also has an email and org id: the app must drop them (the tests check it never shows them).
    const out = state.loggedIn
      ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: state.plan ?? "max", email: "fixture@example.invalid", orgId: "org-fixture" }
      : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  const stdin = await readStdin();
  const schemaText = flag(argv, "--json-schema");
  const schema = schemaText ? JSON.parse(schemaText) : null;
  const tools = schema ? toolNames(schema) : [];
  const alias = flag(argv, "--model") ?? "opus";
  const model = MODELS[alias] ?? alias;
  const turn = (stdin.match(/<assistant-[0-9a-f]{8}>/g) ?? []).length;
  const role = tools.includes("classify") ? "triage" : tools.includes("submit_spec") || tools.includes("set_spec_tests") ? "spec_writer" : "designer";
  if (s.record) {
    const cwd = process.cwd();
    const n = `${Date.now()}-${process.pid}`;
    writeFileSync(
      join(s.record, `call-${n}.json`),
      JSON.stringify({
        argv,
        cwd,
        cwdMode: statSync(cwd).mode & 0o777,
        env: Object.keys(process.env).sort(),
        tmpdir: process.env.TMPDIR ?? null,
        stdinBytes: Buffer.byteLength(stdin),
        promptInArgv: stdin.length > 20 && argv.some((a) => a.includes(stdin.slice(0, 40))),
        role,
        turn,
        tools,
      }),
    );
  }

  const init = {
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: SESSION,
    // A scenario can report extra tools (e.g. "Bash") to check that the app's tripwire stops the run.
    tools: s.initTools ?? (schema ? ["StructuredOutput"] : []),
    mcp_servers: [],
    model,
    permissionMode: "dontAsk",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "2.1.260",
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "00000000-0000-4000-8000-000000000002",
  };
  line(init);

  if (!state.loggedIn) {
    // Recorded shape of a logged-out run (llm-gateway fixtures claude/not-logged-in.jsonl).
    line({ type: "assistant", message: { id: "msg_logged_out", model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", type: "message", content: [{ type: "text", text: "Not logged in · Please run /login" }] }, error: "authentication_failed", session_id: SESSION });
    line({ type: "result", subtype: "success", is_error: true, num_turns: 1, result: "Not logged in · Please run /login", session_id: SESSION, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    process.exitCode = 1;
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  line({
    type: "rate_limit_event",
    rate_limit_info: {
      status: s.planStatus ?? "allowed",
      resetsAt: now + 3600,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.17, resetsAt: now + 3600 }, seven_day: { utilization: 0.05, resetsAt: now + 4 * 86400 } },
    },
    session_id: SESSION,
  });

  const script = JSON.parse(readFileSync(s.script, "utf8"));
  const turns = script[role] ?? [];
  const t = turns[turn] ?? { text: "Nothing more to do." };
  const envelope = { text: t.text ?? "", tool_calls: (t.tools ?? []).map((c) => ({ name: c.name, arguments: c.input })) };
  const usage = { input_tokens: t.usage?.input ?? 900, cache_creation_input_tokens: t.usage?.cacheWrite ?? 0, cache_read_input_tokens: t.usage?.cacheRead ?? 0, output_tokens: t.usage?.output ?? 120 };
  const cost = s.costUsd ?? 0.004;
  if (s.delayMs) await sleep(s.delayMs);

  if (schema) {
    line({ type: "assistant", message: { model, id: `msg_${role}_${turn}`, type: "message", role: "assistant", content: [{ type: "tool_use", id: `toolu_${role}_${turn}`, name: "StructuredOutput", input: envelope }], stop_reason: null, usage }, session_id: SESSION });
    line({ type: "user", message: { role: "user", content: [{ tool_use_id: `toolu_${role}_${turn}`, type: "tool_result", content: "Structured output provided successfully" }] }, session_id: SESSION });
  }
  line({ type: "assistant", message: { model, id: `msg_${role}_${turn}_end`, type: "message", role: "assistant", content: [{ type: "text", text: schema ? "Done." : envelope.text || "Done." }], stop_reason: "end_turn", usage: { ...usage, output_tokens: 4 } }, session_id: SESSION });
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: schema ? 2 : 1,
    result: schema ? "Done." : envelope.text || "Done.",
    stop_reason: "end_turn",
    session_id: SESSION,
    total_cost_usd: cost,
    usage,
    modelUsage: { [model]: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreationInputTokens: usage.cache_creation_input_tokens, costUSD: cost, costBasis: "list" } },
    ...(schema ? { structured_output: envelope } : {}),
  });
}

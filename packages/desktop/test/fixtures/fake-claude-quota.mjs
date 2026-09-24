// A fake `claude` (Claude Code 2.1.260) whose plan limit is used up, for the desktop runner tests. Detection sees the
// same CLI as e2e/fixtures/fake-cli/fake-claude.mjs (version, the recorded help, logged in with a Max plan); every
// model call answers in the shape the real CLI uses when the plan is exhausted: `init`, a `rate_limit_event` with
// status `rejected` (the 5-hour window used up, the 7-day window at 40 % resetting days later), then an error
// `result` ("Claude AI usage limit reached|<epoch>").
// Completion mode (single calls) only: it never launches the `cad` MCP server a runtime phase expects. No network, no
// key, no real CLI state.
import { readFileSync } from "node:fs";

const SESSION = "00000000-0000-4000-8000-0000000000aa";
/**
 * The 7-day window resets this much later than the exhausted 5-hour one, as in the recorded real output
 * (packages/llm-gateway/test/cli/fixtures/claude/completion-plain.jsonl: 1790445600 - 1790219400 s): the reset
 * time shown must be the 5-hour window's, not the latest one.
 */
export const SEVEN_DAY_LATER_S = 226_200;
const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/** `s`: { help: <recorded --help file>, resetsAt: <epoch seconds> }. */
export async function main(s) {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) return void process.stdout.write("2.1.260 (Claude Code)\n");
  if (argv.includes("--help") || argv.includes("-h")) return void process.stdout.write(readFileSync(s.help, "utf8"));
  if (argv[0] === "auth") return void line({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" });
  await readStdin();
  line({ type: "system", subtype: "init", cwd: process.cwd(), session_id: SESSION, tools: argv.includes("--json-schema") ? ["StructuredOutput"] : [], mcp_servers: [], model: "claude-haiku-4-5-20251001", permissionMode: "dontAsk", apiKeySource: "none", claude_code_version: "2.1.260" });
  line({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: s.resetsAt, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 1, resetsAt: s.resetsAt }, seven_day: { utilization: 0.4, resetsAt: s.resetsAt + SEVEN_DAY_LATER_S } } },
    session_id: SESSION,
  });
  line({ type: "result", subtype: "success", is_error: true, num_turns: 1, result: `Claude AI usage limit reached|${s.resetsAt}`, session_id: SESSION, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
  process.exitCode = 1;
}

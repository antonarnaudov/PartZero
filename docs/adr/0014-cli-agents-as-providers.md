# ADR 0014: CLI agents as providers

- **Status:** Accepted. Amended by [ADR 0015](0015-autonomy-dial.md) (what follows the PROPOSE gate) and [ADR 0020](0020-funded-eval-keys-fallback.md) (eval runs only: funded API keys as a fallback). See the addendum below.
- **Date:** 2026-09-24
- **Plan reference:** PLAN-2026-09-23 §2 D9. Extends [ADR 0009](0009-model-agnostic-llm-gateway.md) and does not replace it.
- **Design:** [CLI-PROVIDERS.md](../CLI-PROVIDERS.md) freezes the interfaces for the build waves.

## Context

- **We will not pay for per-token API keys for now.** The product owner requires:
  - every provider stays first-class: vendor APIs, OpenAI-compatible endpoints and local models;
  - every major **CLI coding agent** becomes a first-class provider: headless Claude Code (`claude -p`), Gemini CLI, OpenAI Codex CLI, opencode and Cursor Agent;
  - users run the CLI they have already installed and logged into, on their own subscription;
  - live testing uses Claude Code only for now. That plan's limits are shared with development work.

  Using a CLI agent as an API is already proven in other apps.
- **ADR 0009 assumes stateless request/response APIs** reached with keys through official SDKs. Our orchestrator runs the tool loop itself and resends the whole history on every call. A CLI agent is different: it has its own agent loop, its own session store and its own powerful **built-in tools** (shell, file edit, web search and fetch, sub-agents).
- **Research (2026-09-24; evidence in [CLI-PROVIDERS.md §2](../CLI-PROVIDERS.md#2-evidence)):**
  - Every one of these CLIs has a headless mode that emits JSON or JSONL events.
  - Every one is an MCP client.
  - Every one can have its built-in tools switched off, but each does it differently: flags, a config layer, a permission engine or an OS sandbox.
  - They differ on structured output, session resume, cost reporting and how they fail. Claude and Codex accept a JSON Schema for the final answer. Gemini, opencode and Cursor do not.
  - Some failures are silent. opencode retries a 429 forever with no output. Gemini can exit 0 after an invalid model stream.
- **Verified here with Claude Code 2.1.260** (two live Haiku runs, about $0.012 of plan usage at list prices):
  - With `--restricted --tools "" --strict-mcp-config --mcp-config <ours> --permission-mode dontAsk --allowedTools mcp__cad`, the model's toolset is exactly our MCP tools, plus `StructuredOutput` when `--json-schema` is passed.
  - Plugins, skills and slash commands are empty. A canary in the working directory's `CLAUDE.md` was not visible to the model.
  - The subscription login works from a minimal environment (`HOME`, `PATH`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`), with no API key.
  - `--safe-mode` silently drops `--mcp-config` servers, so it cannot be used.
- **Risks:**
  - The CLIs update themselves, so their flags drift.
  - Output formats are undocumented or change between versions.
  - The CLI owns its loop and its context, so our per-turn control is weaker.
  - Data sent through a CLI falls under the user's consumer or plan terms with that vendor.

## Decision

1. **Three provider kinds.** Every `Provider` has a kind:
   - `api`: `anthropic`, `openai`, `google`, `openai-compat`;
   - `cli`: `claude-cli`, `gemini-cli`, `codex-cli`, `opencode`, `cursor-agent`;
   - `local`: `ollama`, through a native `/api/chat` adapter so we can set `num_ctx`.
     *Amended 2026-09-24:* until that adapter exists, local profiles are `openai-compat` profiles with a `local` block and `billing: "local"`; hosts classify them with `profileKind()`, and `ollamaContextCheck()` warns when the server's context is below `local.numCtx` (docs/CLI-PROVIDERS.md §10, §16).

   API keys become optional. Role routing, profiles, the judge-family rule and budgets keep working unchanged, because a CLI model is an ordinary **profile** (for example `claude-cli:opus`).

2. **Two integration modes.**
   - **Completion mode.** A CLI is used as a model endpoint for single-shot calls: triage, CLARIFY, the judge, and any tool loop whose provider cannot run in runtime mode.
     - The gateway gets a `CliAdapter` (pure mapping) and a `CliTransport` (spawns the process). One `ChatRequest` becomes one fresh, stateless CLI invocation, with every built-in tool disabled.
     - Tool calls come back through a strictly validated **turn envelope** (`{text, tool_calls[]}`). How the envelope is delivered depends on the CLI:
       - its native JSON Schema output (`claude --json-schema`, `codex --output-schema`);
       - a single `submit_turn` tool on our MCP server (Gemini, opencode, Cursor);
       - as a last resort, a strict parse of JSON text.
     - Our orchestrator then runs the tools exactly as it does today.
   - **Agent-runtime mode.** The CLI's own agent loop drives the SPEC, BUILD and ASK loops, calling **only our CAD tools**.
     - It reaches those tools through our MCP server (`packages/mcp-server`, stdio). That server is a thin shim that forwards each call over a private socket to a **tool broker** in the host process.
     - The broker runs every call through the same `AgentRun` code path as today. So nothing changes in:
       - the L0–L3 verification ladder;
       - REPAIR/REPLAN notes;
       - `same_error` and `repairs_exhausted` stops;
       - the PROPOSE and REFINE gates;
       - the 80 % budget checkpoint;
       - `ask_user`, and draft events.
     - Our orchestrator still owns the phases. It picks the phase, starts one fresh CLI process per phase (the spec writer never shares a session, a nonce or a broker with the designer), and scopes the tools to that phase.
     - It enforces the stop rules on three levels:
       - the broker refuses every call after a stop condition;
       - `--max-turns` or the CLI's equivalent;
       - wall-clock and stall timeouts that kill the whole process group.

   Mode selection is a per-phase rule (see [CLI-PROVIDERS.md §3.4](../CLI-PROVIDERS.md#34-mode-selection)). Runtime mode is preferred for tool loops, because it keeps the CLI's native tool calling and its prompt cache.

3. **Lockdown is mandatory, and it is version-gated.** Every invocation applies all of the following:
   - disables the CLI's built-in tools and settings layers, using the exact flags or config for that CLI;
   - uses a strict MCP config that contains only our server;
   - runs in a fresh, empty `0700` temp working directory;
   - gets an **allowlisted environment**, which contains no API secrets and no redirecting variables;
   - redirects `TMPDIR`;
   - runs in its own process group;
   - feeds prompts through stdin or files, never through argv (Cursor is the only exception).

   **Tripwires** check the stream at runtime:
   - The init event's tool list must contain only our tools. Claude reports this list.
   - Any call to a non-CAD tool kills the run with `lockdown_violation`.

   We **refuse to run** a CLI whose version or configuration cannot enforce the lockdown. At acceptance, `cursor-agent` is refused: it has no documented way to turn off its web search in headless runs, and the installed build lacks the needed flags. It becomes available once a verified build exists.

   CLI output is untrusted input. It is size-capped, parsed defensively, never executed and never rendered as markup.

4. **The user's own login, and nothing else.**
   - We invoke the official binary the user installed.
   - We never read, copy or forward its credentials: no credential files, no keychain entries, no `*_API_KEY` or `*_TOKEN` variables.
   - We never pass `--bare`. It disables Claude Code's OAuth, and so the user's subscription.
   - Login state comes from a cheap probe that makes no model call: `claude auth status --json` or `codex login status`, the presence (never the contents) of a credential file, or the failure signature of a run.
   - Settings tells the user that CLI runs use their own plan and its limits and terms.

5. **Accounting.**
   - Each profile carries `billing: metered | subscription | local`.
   - Subscription runs charge the task budget with **notional** cost. This is the CLI's own `total_cost_usd` when it reports one (Claude, list basis), otherwise the profile's list pricing, otherwise 0. Turn, wall-clock and token limits always apply.
   - Claude's `rate_limit_event` (utilization of the five-hour and seven-day windows) is shown as plan usage.

6. **One MCP server, generated from the tool registry.**
   - `packages/mcp-server` ships:
     - the stdio shim;
     - the bridge protocol;
     - the host-side broker, with scopes, rate limits and per-client branches;
     - later, the headless/external mode from ARCHITECTURE §9.
   - The shim itself holds no state and no secrets. It authenticates to the broker with a per-run ticket, which lives only in process environments.

7. **Where CLI providers run.** They are Node-only: the desktop agent utility process, and headless Node (the CLI and evals). The CLI code sits behind the `@aicad/llm-gateway/cli` and `@aicad/agent/cli-runtime` subpath exports, so browser and server builds never import `child_process`.

8. **Testing.**
   - Offline tests are the default:
     - recorded JSONL fixtures;
     - a fake CLI binary that makes real MCP calls through the real shim and broker;
     - Gemini's hidden `--fake-responses` replay against the real binary when it is installed.
   - The live suite is a **small, opt-in Claude Code smoke profile** (`AICAD_LIVE_CLI=claude`) of at most three CLI invocations. It never runs in CI, because it spends the maintainer's plan limits.

## Consequences

- **Positive:**
  - The app works with no API keys, using whatever CLI agents or local models the user already has. Its cost per task to us is zero.
  - Every provider keeps working, and the leaderboard can rank CLI profiles next to API profiles.
  - The CLI's native tool calling and prompt caching are used in the long BUILD loop. Our rules and verification stay authoritative, because every effect goes through our broker.
  - The MCP server this needs is the same one ARCHITECTURE §9 plans for external agents, so we build it once.
- **Negative / costs:**
  - **Weaker per-turn control in runtime mode.** The CLI owns context management: compaction, cache placement and its own system-prompt additions. It can also silently reroute models (Gemini `auto`, Codex reroutes).
  - **We can bound spend but not reserve it.** The budget is enforced at tool-call boundaries, so one model turn can overshoot it.
  - **Surface to maintain:**
    - five CLI dialects that drift with every release;
    - lockdown specs that each need re-verification per version range;
    - a Windows story, because `.cmd` shims and argv limits push prompts to stdin.
  - **Completion-mode tool loops cost more.** They are stateless and resend a transcript on every call. They are a fallback, not the main path.
  - **Plan limits are shared.** A user's CLI plan is shared with their own interactive use, and each vendor's terms and data handling apply.
- **Follow-ups:**
  - The build waves in [CLI-PROVIDERS.md §14](../CLI-PROVIDERS.md#14-build-waves).
  - ARCHITECTURE §6 and §9 get pointers to this ADR.
  - [AGENT-IN-APP.md](../AGENT-IN-APP.md) gets a providers section when wave 3 lands.
  - Re-verify each CLI's lockdown on every new version range.
  - Verify Cursor with a logged-in build before enabling it.
  - Revisit ACP (Agent Client Protocol) as a common runtime transport once more CLIs support it.

## Addendum (2026-09-24): funded eval keys and the autonomy dial

The text above stays as written; read it with these changes.

- **[ADR 0020](0020-funded-eval-keys-fallback.md), funded eval keys (eval runs only).**
  - "We will not pay for per-token API keys for now" still holds for the app and for development.
  - For eval runs, owner-funded API keys are a fallback. They pay only for rows that plans and local models cannot run weekly (2 missed weeks in any 4). Funded runs start no earlier than open alpha (~M8, May 2027), for every eval run including the spike 07 bake-off, after BACKLOG's wall-time cap, under a hard cap of $2k a month from ARCHITECTURE §8's existing eval budget.
  - The owner creates and holds the keys. Agents never receive them, and funded runs never run in CI. Decisions 4 and 8 are unchanged, and an app user's cost per task to us stays zero.
  - Consequences, Negative / costs, gains: "Evals may spend up to $2k a month on metered API keys when ADR 0020's trigger fires."
- **[ADR 0015](0015-autonomy-dial.md), the autonomy dial.** The PROPOSE gate in Decision 2 is unchanged. What follows a passing gate is set by the dial and decided by our orchestrator and the host's commit check, never by the CLI. Runtime and completion modes behave the same. A CLI's own permission or approval mode never counts as the user's approval. At "Ask at each step", a CLI that cannot wait for the user's answer inside a tool call runs BUILD in completion mode.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Keep API keys only (ADR 0009 as is) | Violates the owner's no-paid-keys requirement, and users without keys could not use the app |
| Extract the CLI's OAuth token and call the vendor API directly | Handles the user's credentials. It breaks when the vendor changes auth, and it is exactly what vendors restrict. We automate only the official binary. |
| Completion mode only | Every BUILD turn would resend a growing transcript to a fresh process. That means quadratic tokens, CLI startup on every turn, no prompt cache, and weaker tool use than the model's native tool calling. |
| Runtime mode only | Triage, CLARIFY and the judge are single-shot structured calls, and a process plus MCP broker for each of them adds latency and cost for nothing. Some CLIs (Cursor) cannot yet expose only our tools. |
| Native tool capture in completion mode ("capture and cut": the MCP tool records the call and the process is killed) | Feeds the model fake tool results, loses the final result and usage event, and adds a round trip or a kill on every turn. The envelope is simpler and deterministic. |
| Vendor agent SDKs (Claude Agent SDK, Codex SDK) as the runtime | One vendor each. They bundle their own CLI builds and would give us five different integrations. We need one broker contract across all CLIs. The Agent SDK stays in the external-agent eval track (ADR 0009). |
| ACP (Agent Client Protocol) for every CLI now | Only Gemini speaks it natively among our five, and we have not verified it with the others. It stays a candidate transport per CLI. |
| Streamable HTTP MCP on localhost instead of a stdio shim | A TCP listener that any local process can reach, and it depends on each CLI's header support. Every CLI supports stdio, and a `0700` Unix socket or named pipe plus a ticket is a smaller surface. HTTP stays planned for external clients (ARCHITECTURE §9). |
| Let the CLI keep its tools and rely on an OS sandbox | A sandbox cannot stop web search or fetch from leaking the design, it differs per OS, and Gemini's sandbox relaunches the whole CLI. The primary control is removing the tools. OS sandboxes are an extra layer where the CLI offers one (Codex, Cursor). |

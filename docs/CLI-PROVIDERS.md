# CLI agents, local models and API providers: implementation design

- **Status:** Design **frozen** 2026-09-24 for build waves 1–4 (§14). A change to a frozen interface after the freeze needs an entry in §16 and a note in the PR.
- **Decision:** [ADR 0014](adr/0014-cli-agents-as-providers.md). It extends [ADR 0009](adr/0009-model-agnostic-llm-gateway.md).
- **Related:**
  - [ARCHITECTURE.md §6](ARCHITECTURE.md#6-ai-agent-system) (agent) and [§9](ARCHITECTURE.md#9-external-mcp-server-and-cli) (MCP server);
  - [AGENT-IN-APP.md](AGENT-IN-APP.md) (desktop agent, IPC v1, keys).
- **Naming:**
  - Identifiers keep the current `@aicad/*` package scope and the `AICAD_*` environment prefix. Both get renamed along with the product.
  - The MCP server name **`cad`** is product-neutral on purpose. Models see it inside tool names such as `mcp__cad__apply_cadscript`.

**Contents**
1. [Overview](#1-overview)
2. [Evidence](#2-evidence)
3. [Integration modes](#3-integration-modes)
4. [Per-CLI capability matrix and invocation specs](#4-per-cli-capability-matrix-and-invocation-specs)
5. [Security](#5-security)
6. [MCP server (`packages/mcp-server`)](#6-mcp-server-packagesmcp-server)
7. [Gateway: frozen interfaces](#7-gateway-frozen-interfaces)
8. [Agent: frozen interfaces](#8-agent-frozen-interfaces)
9. [Model and provider registry](#9-model-and-provider-registry)
10. [Local models (Ollama)](#10-local-models-ollama)
11. [Desktop and app UX](#11-desktop-and-app-ux)
12. [Usage and budget accounting](#12-usage-and-budget-accounting)
13. [Evals and tests](#13-evals-and-tests)
14. [Build waves](#14-build-waves)
15. [Open verification items](#15-open-verification-items)
16. [Change log](#16-change-log)

---

## 1. Overview

Every model the app can use is a **profile** in the gateway registry. A profile belongs to one provider, and every provider has one of three kinds.

| Kind | Providers | Who pays | How we reach it |
|---|---|---|---|
| `api` | `anthropic`, `openai`, `google`, `openai-compat` | Metered, on the user's key (optional from now on) | Official SDKs (unchanged, ADR 0009) |
| `cli` | `claude-cli`, `gemini-cli`, `codex-cli`, `opencode`, `cursor-agent` | The user's own subscription or plan in that CLI | The official binary, run headless and locked down |
| `local` | `ollama` | Nobody (local compute) | Native `/api/chat` over loopback HTTP |

A CLI provider works in two modes (§3):

```
COMPLETION MODE (single-shot calls; tool loops only as a fallback)
  Agent.callModel ─► LLMGateway.chat ─► CliAdapter.buildRequest ─► CliTurnPayload
                  ─► CliTransport.send ─► CliProvider.buildArgs ─► spawn (fresh workspace, allowlisted env)
                  ─► JSONL ─► CliProvider.parseEvents ─► turn envelope ─► ChatResponse {text, tool_use[]}
  The orchestrator runs the tool_use blocks itself, exactly as it does for an API model.

AGENT-RUNTIME MODE (the SPEC, BUILD and ASK tool loops)
  AgentRun ─► CliAgentRuntime.runPhase ─► spawn CLI (built-ins off, MCP = only "cad")
       ▲                                          │ stdio (the CLI launches our shim)
       │ handleToolCall (same #execute path:      ▼
       │ ladder L0–L3, REPAIR/REPLAN, stop     aicad-mcp shim ── 0700 unix socket + ticket ──► ToolBroker (in AgentRun's process)
       │ rules, PROPOSE gate, budget gate)                                                         │
       └───────────────────────────────────────────────────────────────────────────────────────────┘
  The orchestrator still picks the phases, starts one fresh CLI process per phase, scopes the tools,
  closes the broker at a stop, and kills the process group on a timeout.
```

**What changes, per package:**

| Package | Change |
|---|---|
| `llm-gateway` | <ul><li>Provider union and kinds; `billing` on profiles and responses.</li><li>New `src/cli/` (Node-only, subpath export `@aicad/llm-gateway/cli`): `CliProvider` and five implementations, process control, env allowlist, workspace, lockdown, turn envelope, `CliAdapter`, `CliTransport`.</li><li>`OllamaAdapter` and `OllamaTransport`.</li><li>`BudgetGuard.charge` and `Task.chargeExternal`.</li></ul> |
| `mcp-server` (new) | <ul><li>The stdio MCP shim (`aicad-mcp`).</li><li>The bridge protocol.</li><li>The host-side `ToolBroker`, which implements `CliMcpHost`.</li><li>Scopes, and later the headless/external mode.</li></ul> |
| `agent` | <ul><li>`AgentRuntime` and `CliAgentRuntime` (subpath `@aicad/agent/cli-runtime`).</li><li>Runtime phases in `AgentRun`, and a runtime spec writer.</li><li>Stop reason `lockdown_violation`.</li><li>`cliMode` option.</li></ul> |
| `agent-tools` | `ToolRegistry.defs()` fills the new `ToolDef.readOnly` field. |
| `desktop` | <ul><li>CLI detection and auth probes (main process).</li><li>The start precheck is generalized.</li><li>The worker wires in the CLI transports, the runtime and the broker.</li><li>An env allowlist for CLIs.</li></ul> |
| `app` | <ul><li>The provider picker.</li><li>CLI and local status in Settings.</li><li>IPC v1 additions (additive).</li><li>A plan-usage display.</li></ul> |
| `evals` | Unchanged API. `LLMSolver` runs over CLI profiles, and there is a live smoke profile. |

---

## 2. Evidence

**Labels:**
- **[V-here]** Verified during this design pass on this machine.
- **[V-research]** Verified by the research pass, on the real binary but offline or against a mock.
- **[SRC]** Read in the CLI's source.
- **[DOCS]** From official docs only.
- **[UNVERIFIED]** Not confirmed either way.

A frozen spec that rests on anything below [V-here] has a matching item in §15.

### 2.1 Claude Code 2.1.260 [V-here]

**Method:**
- `claude --help`, `claude auth status --json` and `strings` over the installed binary.
- Two live `claude -p` runs on Haiku, in a scratch working directory, against a 40-line stdio MCP test server.
- Total spend: about **$0.012 of plan usage** (list basis). The scratch files have been deleted.
- The owner's credentials were never read. `auth status` output was filtered to non-identifying fields.

**Findings:**
- **Flags.**
  - `claude --help` lists: `--tools`, `--mcp-config`, `--strict-mcp-config`, `--permission-mode` (with `dontAsk`), `--allowedTools`, `--restricted`, `--safe-mode`, `--disable-slash-commands`, `--no-session-persistence`, `--json-schema`, `--input-format stream-json`, `--output-format stream-json`, `--effort`, `--max-budget-usd`, `--settings` and `--setting-sources`.
  - Hidden but present in the binary: `--max-turns <turns>` ("only works with --print") and `--system-prompt-file <file>`.
  - Env names present in the binary: `MCP_TOOL_TIMEOUT`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`.
  - Settings keys present in the binary: `disableAllHooks` and `autoMemoryEnabled`.
- **Run A** used `--safe-mode --tools "" --mcp-config <ours> --strict-mcp-config --permission-mode dontAsk --allowedTools mcp__cad --json-schema …`.
  - `init.tools` was `["StructuredOutput"]` and `init.mcp_servers` was `[]`.
  - **`--safe-mode` drops `--mcp-config` servers**, so it must never be used.
  - `apiKeySource` was `"none"`: the subscription login was used.
  - The environment held only `HOME`, `PATH`, `USER`, `LOGNAME`, `TMPDIR` and `LANG`.
- **Run B** used `--restricted --disable-slash-commands` in place of `--safe-mode`, with the other flags the same.
  - `init.tools` was `["StructuredOutput","mcp__cad__ping"]`, and `init.mcp_servers` was `[{"name":"cad","status":"connected"}]`.
  - `plugins` was `[]`, and skills and slash commands were both 0.
  - A canary in `./CLAUDE.md` was **not** seen by the model, and no user memory was seen.
  - `result.structured_output` held the schema-valid object; `num_turns` was 3 and `total_cost_usd` was 0.006105.
  - The MCP child **inherits the CLI's environment**. It received the variable set in the config's `env` plus the CLI's own variables: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_PROJECT_DIR` and `AI_AGENT`.
  - `tools/call` params carry `_meta: {"claudecode/toolUseId", progressToken}`.
  - `--no-session-persistence` left no project directory under `~/.claude/projects`.
- **Event shapes (stream-json).**
  - `system/init`: `session_id`, `model`, `tools`, `mcp_servers`, `permissionMode`, `apiKeySource`, `claude_code_version`, `plugins`, `skills`, `slash_commands`, `agents`, and more.
  - `rate_limit_event`: `rate_limit_info {status, resetsAt, rateLimitType, overageStatus, isUsingOverage, unifiedWindows {five_hour {utilization, resetsAt}, seven_day {…}}}`.
  - `system/thinking_tokens`: `{estimated_tokens, estimated_tokens_delta}`.
  - `assistant`: one event **per content block**. Blocks of one message share `message.id`. Each event carries `message.usage`, and `stop_reason` is `null` in the stream.
  - `user`: `tool_result` blocks, plus `tool_use_result`.
  - `result`: `subtype`, `is_error`, `num_turns`, `total_cost_usd`, `usage`, `modelUsage {<model>: {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, thinkingTokens, costUSD, canonicalModel, costBasis:"list"}}`, `structured_output`, `permission_denials`, `session_id`, `stop_reason`, `terminal_reason`, `api_error_status` and `result` (text).
  - `StructuredOutput` shows up as an assistant `tool_use` block named `StructuredOutput`.
  - Result subtypes present in the binary: `success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd` and `error_max_structured_output_retries`.
- **`claude auth status --json`** returns the keys `loggedIn`, `authMethod` (`"claude.ai"`), `apiProvider` (`"firstParty"`), `subscriptionType` (`"max"`), `email`, `orgId`, `orgName`, `projectsDirectory` and `analyticsDisabled`. It makes no model call.

### 2.2 Other CLIs (research pass, 2026-09-24)

- **Gemini CLI 0.49.0** [V-research, offline, real binary]. The run used `--fake-responses-non-strict`, a throwaway home directory and a dummy key. Verified:
  - the stream-json and json schemas;
  - the exit codes;
  - that `tools.core` filters both MCP and built-in tools;
  - the policy-rule format;
  - that headless default mode drops write, shell and untrusted-MCP tools;
  - that workspace settings load only with `GEMINI_CLI_TRUST_WORKSPACE=true`;
  - that `GEMINI_SYSTEM_MD` replaces the system prompt;
  - `@path` image injection;
  - the session-id collision bug;
  - ACP `session/new` with `mcpServers`.
- **Codex CLI 0.156.1** [SRC and DOCS; not installed]. Read from the source: the flags (`exec/src/cli.rs`), the event schema (`exec_events.rs`), the MCP approval denial under `approval_policy=never` (`mcp_tool_call.rs`), strict `--output-schema`, and resume.
- **opencode 1.17.10** [V-research, isolated XDG, mock provider and mock MCP]. Verified:
  - the NDJSON events;
  - that a `permission` deny removes tools from the model's list;
  - that the agent prompt replaces the base prompt;
  - tool naming `cad_<tool>`;
  - silent 429 retries;
  - the `-f` image path;
  - the extra title call, which `--title` prevents.
- **Cursor Agent 2026.01.28** [V-research, logged out]. Verified: the auth failure text and exit 1, and that `--trust`, `--yolo` and `--format` are missing. The stream-json schema comes from the docs and the bundle.
- **Ollama 0.34.2** [V-research]. The server is running, but no models are pulled. Verified: `/api/version`, `/api/tags`, `/api/show` and the error shapes. The context default is 4k when VRAM is under 24 GiB [DOCS].

Full field-level notes are in the research record that this design was built from. Each per-CLI section in §4 repeats what an implementer needs.

---

## 3. Integration modes

### 3.1 Completion mode

**Used for:**
- single-shot calls: triage, CLARIFY and the future L5 judge;
- tool loops, but only as a fallback when runtime mode is unavailable or turned off (§3.4).

**Rules (frozen):**
1. **One `ChatRequest` → one fresh CLI invocation.** Each invocation is **stateless**:
   - it runs in a new workspace (§5.4);
   - no session is persisted, where the CLI allows it (§4 has the details per CLI);
   - it never resumes a session.

   The request's full history is rendered into a transcript (§3.2.4). This keeps spec-writer isolation trivially true, and it makes every call replayable from its payload.
2. **All built-in tools are disabled** (§4, §5).
   - No MCP servers run, except ours in `submit` scope when the envelope goes through `mcp-submit`.
   - `maxTurns` is 3 (room for structured-output retries).
   - Default timeouts: wall 180 s and stall 120 s. A completion-mode designer turn gets a 300 s wall.
3. **The model answers with one turn envelope** (§3.2). The adapter maps it to an `AssistantMessage` with `text` and `tool_use` blocks. `stopReason` is `tool_use` when the envelope has calls, and `end_turn` otherwise.
4. **Tools are not executed by the CLI.** The orchestrator executes `tool_use` blocks through `ToolRegistry.execute`. That validates the input with zod and returns actionable errors. From there on, nothing differs from an API model.
5. **Streaming.** `preferStream` is `false`. If a caller uses `gateway.stream()`, `parseStream` synthesizes `message_start` / `text_delta` / `tool_use_*` / `usage` / `message_end` events from the finished outcome. There are no live deltas.
6. **Reasoning.** CLI thinking is dropped. No `ReasoningBlock` is produced, so there is nothing to replay.

### 3.2 Turn envelope protocol, version 1 (frozen)

#### 3.2.1 Shape

```ts
/** Everything the model says in one assistant turn. `tool_calls: []` means a final answer. */
export interface TurnEnvelope {
  text: string;                                                     // "" when there is nothing to say
  tool_calls: Array<{ name: string; arguments: Record<string, unknown> }>;
}
```

**JSON Schema** (generated by `envelopeSchema(tools, style)`):
- **Top level:** an object with exactly `text` (string) and `tool_calls` (array). `additionalProperties` is false.
- **Each `tool_calls` item** is an `anyOf` with one branch per tool. A branch is `{type:"object", properties:{name:{type:"string", enum:["<tool>"]}, arguments:<that tool's input schema>}, required:["name","arguments"], additionalProperties:false}`.
- **`style`:**
  - `"plain"`: tool schemas as the registry emits them (`toStrictJsonSchema`). Used for Claude.
  - `"openai-strict"`: tool schemas passed through `toOpenAIStrictSchema`, so every property is required and optional ones are nullable. Used for Codex.
- **`parallelToolCalls: false`** gives `tool_calls` a `maxItems` of 1. The hard cap is 16 calls.
- **No tools, or `toolChoice: "none"`:** there is no envelope. The CLI answers in plain text, and the final text is the answer.

#### 3.2.2 Delivery channels (`EnvelopeVia`)

| Channel | How the envelope comes back | Used by |
|---|---|---|
| `json-schema` | Claude: `--json-schema '<schema>'` → `result.structured_output` [V-here]. Codex: `--output-schema <ws>/envelope.schema.json` → the final `agent_message.text` is a JSON string [SRC]. | `claude-cli`, `codex-cli` |
| `mcp-submit` | Our MCP server exposes one tool, `submit_turn`, whose input schema is the envelope. The broker validates it server-side. Invalid input returns `isError` with the reason, and the model retries inside the same invocation. Valid input is recorded, answered with `"Recorded. End your turn now."`, and the broker closes. | `gemini-cli`, `opencode` |
| `text-json` | The final assistant text must be exactly one JSON object, optionally inside a single ```` ```json ```` fence. Anything else fails. | Fallback for every CLI; the default for `cursor-agent` |

Two further rules:
- **Windows limit.** On Windows, or when the schema exceeds 24 KiB, Claude uses `mcp-submit` rather than `json-schema`, because of argv length limits.
- **Profile override.** A profile can override its channel with `cli.envelopeVia`.

#### 3.2.3 Validation (strict)

`extractEnvelope(raw, source)` accepts the value only when **all** of these hold:
- It is a plain object with exactly the keys `text: string` and `tool_calls: array`.
- The JSON is at most 256 KiB, and there are at most 16 calls.
- Each call has a `name` string and an `arguments` object.

Then:
- **A name not in the request's tools** becomes a `ToolUseBlock` with `inputError: "unknown tool <name>"`. The registry answers it with its usual "Unknown tool" error, so the model can retry.
- **Argument schemas are not validated by the gateway.** `ToolRegistry.execute` validates them with zod and answers "Invalid input … fix the arguments", as it does today.
- **Ids** are `cli_<callIdPrefix>_<turn>_<k>`. The prefix is 8 hex characters per invocation.

**Repair:**
- In `text-json` only: one extra invocation. It uses the same stateless payload, plus the invalid reply, plus the fixed note `Your previous reply was not one valid JSON object in the required format (<error>). Reply with only that JSON object.`
- In every channel: if the envelope is still invalid, throw `GatewayError("bad_output")`. The orchestrator turns that into `AgentStop("model_error")`.

#### 3.2.4 Transcript rendering

`renderTranscript(messages, fence)` renders the request history deterministically:
- `fence` is 8 random hex characters per invocation. Content cannot forge a closing tag it does not know.
- Images go into the `images` list only when the provider has an image channel. Otherwise they become `[image omitted]`, with a warning.

```
<transcript-7f3a9c21>
<user-7f3a9c21>
…user text (already nonce-tagged by the orchestrator where it carries file data)…
</user-7f3a9c21>
<assistant-7f3a9c21>
{"text":"…","tool_calls":[{"name":"apply_cadscript","arguments":{…}}]}
</assistant-7f3a9c21>
<tool-result-7f3a9c21 call="cli_…_0_0" name="apply_cadscript" error="false">
…tool output text…
</tool-result-7f3a9c21>
</transcript-7f3a9c21>
Write the next assistant turn.
```

The system prompt is assembled as follows:
- **Base:** the request's `system` blocks, joined with blank lines.
- **Appendix:** `envelopeAppendix(tools, via)`, a fixed and versioned text. It says:
  - the reply is one envelope;
  - the model has no tools of its own;
  - tool results arrive in `tool-result` blocks;
  - which channel to use. For `text-json` and `mcp-submit` it also lists every tool with its description and JSON Schema. For `json-schema`, the schema is enforced and the descriptions are listed.

### 3.3 Agent-runtime mode

**Used for:** the SPEC, BUILD and ASK tool loops, when the role's profile is a CLI profile with `runtime` in `cli.modes` and the host injected an `AgentRuntime` (§3.4).

**Phases stay ours.** TRIAGE and CLARIFY run in completion mode, and each runtime phase is a separate CLI process.

| Phase | Scope | System prompt | First message | Ends when |
|---|---|---|---|---|
| SPEC | `spec`: `set_spec_tests`, `submit_spec` | Spec-writer prompt + runtime appendix | `specHeader()` (spec-writer nonce, clarification topics only) | `submit_spec` succeeds (broker closes). After `maxSpecTurns` or a CLI turn end without it, the phase ends with "no spec", as today. |
| BUILD | `design`: `DESIGNER_TOOLS` (without `ask_user` when the CLI's `maxToolCallMs` < the question wait; see below) | Designer prompt + CadScript reference + conventions + runtime appendix | `#buildHeader(kind)` (request, clarifications, frozen spec, tests, budget line, directive) | PROPOSE is accepted, or an `AgentStop` fires (broker closes), or a limit is hit |
| ASK | `read`: `READ_ONLY_TOOLS` | Designer prompt + reference + runtime appendix | Task lines + the question directive | The CLI ends its first turn. Its final text is the answer. |

**The runtime appendix** is fixed and versioned (`RUNTIME_APPENDIX_V1`). It says:
- the only tools are the `cad` server's CAD tools, and there is no shell, file or web access;
- the instructions use bare tool names, and this CLI shows them as `<qualifiedToolName(example)>`;
- results come from the real engine;
- orchestrator notes, which start with the run's tag, can follow a tool result;
- once a result says the task has ended, the model stops calling tools and replies with one line.

**Isolation.**
- Every phase gets its own `CliWorkspace`, `ToolBroker`, ticket and CLI process.
- Session persistence is off where the CLI supports that (Claude). Elsewhere the session is deleted after the phase.
- The spec writer runs with the derived spec-writer nonce and never sees builder messages. There is no `--resume` across phases.

**Tool execution** (the handler is bound to `AgentRun`):

```
broker call ─► handler(call):
  if AgentRun ended / pendingStop / aborted → { text: "<orch> Not executed: the task has ended.", isError: true, close: reason }
  await #budgetGate()                        // 80 % checkpoint: may ask the user (interactive) or stop
  notes = []
  out = await #execute(toolUseBlock(call), notes)   // the SAME method the gateway loop uses:
                                                    //   registry.execute → ladder L0–L3
                                                    //   #afterApply: checkpoints, REPAIR/REPLAN, same_error, repairs_exhausted
                                                    //   #onPropose: PROPOSE gate, REFINE rejections, known issues
                                                    //   onDraft events
  text = out.text + (notes.length ? "\n\n" + notes.join("\n\n") : "")
  close = (#ended || #pendingStop) ? reasonOf(...) : undefined
  return { text, isError: out.isError ?? false, close, userWaitMs }
```

So the model receives the same L0–L3 results, repair playbook hints and orchestrator notes as it does over the API. Today those notes go in a separate text block of the next user message. In runtime mode they are appended to the tool result, because a CLI cannot inject a user message in the middle of a turn.

**Stop rules (three layers).**
1. **Broker.** After `close(reason)`, every call is answered with `BROKER_CLOSED_TEXT(reason)` (`"<orch> The task has ended (<reason>). Do not call any more tools; reply with one short line."`). After `closeGraceMs` (5 s), or once 2 more calls arrive, the driver kills the process group.
2. **The CLI's own turn limit.**
   - Claude: `--max-turns <limits.maxTurns>`. The BUILD limit already includes 2 turns of slack for closing.
   - Gemini: `model.maxSessionTurns`.
   - Codex, opencode: none. The broker counts model turns from the event stream and closes at the limit (`max_turns`).
3. **Process.**
   - Wall-clock timeout: the phase limit, not counting time the handler spends waiting for the user.
   - Stall timeout: no stdout line and no broker call in flight for `stallMs`.
   - Cancel: the AbortSignal kills the process group (SIGTERM, then SIGKILL after 3 s), and the run stops as `cancelled` with the best verified state, as today.

**Turn end without a proposal.** Here the CLI emitted a `result` for its turn while the broker is still open. `onTurnEnd` applies today's nudge rules:
- up to `maxNudges` continuations with the same nudge texts;
- after that, the implicit-proposal gate (`#onPropose(..., {implicit: true})`) or `no_progress`.

The continuation mechanism depends on the CLI (`capabilities.multiTurn`):
- `stdin-stream` (Claude): the driver writes the next user message to the running process.
- `resume` (Gemini, Codex, opencode): a new process resumes that phase's own session with the nudge as its prompt.
- `none`: straight to the implicit-proposal gate.

**`ask_user` in runtime mode.** The MCP call blocks while the user answers.
- The question wait is capped at `CLI_QUESTION_WAIT_MS` (600 s). When the cap is hit, the defaults are used, with a note.
- `ask_user` stays in the BUILD scope only if the CLI's MCP call timeout (`capabilities.maxToolCallMs`) is higher than the wait cap plus 30 s. We raise that timeout per CLI:
  - Claude: env `MCP_TOOL_TIMEOUT=900000`;
  - Gemini: `mcpServers.cad.timeout: 900000`;
  - Codex: `tool_timeout_sec=900`.
- On any other CLI, `ask_user` is removed from the scope. CLARIFY, which runs in completion mode, still asks the clarifying questions up front.

**Budget in runtime mode** (§12):
- Each model turn in the stream (`turn` event) is priced from its usage with the profile's pricing. It is added to an unsettled amount, which the 80 % gate counts.
- At the end of the phase, `task.chargeExternal()` settles the CLI-reported total (Claude `total_cost_usd`), or else the sum of the estimates.
- Claude also gets `--max-budget-usd <remaining cap>` as a backstop on the CLI side [UNVERIFIED for subscription logins; §15].

**Trace and events.**
- Each model turn becomes an `LlmCallRecord` (with `mode: "cli-runtime"`), an `llm` event and a `cost` event.
- Tool calls produce the usual `tool` and `draft` events.
- `RuntimePhaseOutcome.transcript` rebuilds the phase as `Message[]`. Tool results in it come from the broker's log, not from the CLI's echo. `AgentResult.conversations` and eval transcripts keep their current shape.

**Refusals and model switches.**
- A refusal (for example Claude `stop_reason: "refusal"`) becomes `AgentStop("refusal")`. It is never retried.
- If the CLI's actual model (from the usage reports) is outside the profile's family, a warning is added to the trace.

### 3.4 Mode selection

`resolvePhaseMode(profile, phase, options)` decides the mode.

| Phase / role | API or local profile | CLI profile, `cliMode: "auto"` (default) | `cliMode: "completion"` | `cliMode: "runtime"` |
|---|---|---|---|---|
| TRIAGE | gateway | completion | completion | completion |
| CLARIFY | gateway | completion | completion | completion |
| SPEC | gateway loop | runtime if supported, else completion loop | completion loop | runtime, or an error if unsupported |
| BUILD | gateway loop | runtime if supported, else completion loop | completion loop | runtime, or an error if unsupported |
| ASK | gateway loop | runtime if supported, else completion loop | completion loop | runtime, or an error if unsupported |
| Judge (L5, future) | gateway | completion (images through the provider's channel) | completion | completion |

"Supported" means all of the following:
- `profile.cli.modes` includes `runtime`;
- the provider's `LockdownReport.ok` is true;
- an `AgentRuntime` is injected. Browser and server builds never inject one.

Roles can mix. For example, the designer can be `claude-cli:opus` in runtime mode while triage is `claude-cli:haiku` in completion mode.

---

## 4. Per-CLI capability matrix and invocation specs

### 4.1 Matrix

| | Claude Code | Gemini CLI | Codex CLI | opencode | Cursor Agent |
|---|---|---|---|---|---|
| **Provider id** | `claude-cli` | `gemini-cli` | `codex-cli` | `opencode` | `cursor-agent` |
| **This machine** | 2.1.260, logged in (Max) | 0.49.0 (latest 0.60.0) | not installed (latest 0.156.1) | 1.17.10 (latest 1.18.32) | 2026.01.28, logged out |
| **Evidence** | V-here (live) | V-research (offline, real binary) | SRC/DOCS | V-research (mock) | V-research (logged out), DOCS |
| **Headless command** | `claude -p` | `gemini -p` (ACP later) | `codex exec` | `opencode run` (`serve` later) | `cursor-agent -p` |
| **Output** | `--output-format stream-json --verbose` | `-o stream-json` | `--json` | `--format json` | `--output-format stream-json` |
| **Prompt input** | stdin: text or stream-json | stdin, prepended to `-p` | stdin (`-`) | stdin, appended to the message | argv only |
| **Built-ins off** | `--tools ""` (toolset = ours, V-here) | `tools.core` allowlist + policy deny-all + `--approval-mode default` | `features.shell_tool=false`, `web_search="disabled"`, `features.multi_agent=false`, `tools.view_image=false`, `-s read-only` | `permission {"*":"deny","cad_*":"allow"}` (denied tools are not sent, V-research) | `cli.json` deny rules (hiding unverified). **Web search cannot be disabled.** |
| **Config and memory isolation** | `--restricted`, `--disable-slash-commands`, `--settings {disableAllHooks, autoMemoryEnabled:false}`, env `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | `GEMINI_SYSTEM_MD` replaces the prompt; `advanced.ignoreLocalEnv`; `hooksConfig.enabled: false`; `--extensions=none` (no extension hooks, context files, MCP servers, skills or agents; amended, review round 2, real binary); `GEMINI.md` is still appended | `--ignore-user-config`, `--ignore-rules`, `--strict-config` | Agent prompt replaces the base prompt; `OPENCODE_DISABLE_CLAUDE_CODE=1`; config merges with the user's (the global `AGENTS.md` and `instructions` still load, §5.9) | Workspace rules only; Cursor's own system prompt always applies |
| **Per-run MCP** | `--mcp-config <file>` + `--strict-mcp-config` | `<ws>/.gemini/settings.json` (needs `GEMINI_CLI_TRUST_WORKSPACE=true`) | `-c mcp_servers.cad.*` | `OPENCODE_CONFIG_CONTENT` `mcp.cad` | `<ws>/.cursor/mcp.json` + `mcp enable cad` |
| **Our tool as the model sees it** | `mcp__cad__<tool>` | `mcp_cad_<tool>` | server `cad`, tool `<tool>` | `cad_<tool>` | `mcpToolCall` `cad`/`<tool>` |
| **Headless MCP approval** | `--permission-mode dontAsk --allowedTools mcp__cad` (V-here) | `trust: true` + policy allow | `default_tools_approval_mode="approve"` (otherwise denied under approval=never) | permission allow | `mcp enable` (never `--approve-mcps`) |
| **Structured output** | `--json-schema` → `result.structured_output` | none | `--output-schema <file>` (strict) | none | none |
| **Envelope channel** | `json-schema` | `mcp-submit` | `json-schema` | `mcp-submit` | `text-json` |
| **System prompt** | `--system-prompt-file` (hidden, present) | `GEMINI_SYSTEM_MD=<file>` | `-c model_instructions_file=…` | agent `prompt: "{file:…}"` | workspace rules file |
| **Tool list before the first model call** | yes: `init.tools`, `init.mcp_servers` | no | no | no | no |
| **Multi-turn** | `stdin-stream` (SDK protocol) | `resume` (`--resume=<id>`) | `resume` (`exec resume <id>`) | `resume` (`--session=<id>`) | `resume` (`--resume=<id>`) |
| **Sessions persisted** | off (`--no-session-persistence`, V-here) | yes → deleted after the run | completion: `--ephemeral`; runtime: deleted after the run | yes → deleted after the run | yes (left behind) |
| **Max turns** | `--max-turns` (hidden flag) | `model.maxSessionTurns` (exit 53) | none (broker enforces) | none (broker enforces) | none (broker enforces) |
| **Tokens** | per message, plus `result.usage` and `modelUsage` | `result.stats` | `turn.completed.usage` (cumulative per thread) | `step_finish.part.tokens` | `result.usage` (newer builds) |
| **USD** | `total_cost_usd` (list basis, notional) | none | none | `step_finish.cost` (0 for subscriptions) | none |
| **Plan usage** | `rate_limit_event` (5-hour and 7-day utilization) | none (request quotas) | none in exec | none | none |
| **Images** | stream-json image blocks [DOCS/SDK] | `@path` in the prompt | `-i <file>` (prompt on stdin) | `-f <file>` after the message | none |
| **Auth probe (no model call)** | `claude auth status --json` | `security.auth.selectedType` field + creds-file presence | `codex login status` | `opencode models` | `cursor-agent status` (text; exit 0 either way) |
| **Auth failure** | [to record, §15] | exit 41 | exit 1 + message | error event `APIError` 401, exit 1 | exit 1, "Authentication required" |
| **Rate limit / quota** | `rate_limit_event.status`; result `api_error_status` | `TerminalQuotaError` / `RetryableQuotaError`; up to 10 retries | `turn.failed` "hit your usage limit" | Silent retries: stall timer + `--print-logs` | [UNVERIFIED] |
| **Modes at freeze** | completion, runtime | completion, runtime | completion, runtime | completion, runtime | **none (blocked)** |
| **Lockdown at freeze** | `verified` 2.1.260 | `verified` 0.49.x (offline), `static` above | `static` (never run) | `verified` 1.17.x (mock), `static` above | **blocked** |

All CLIs follow two further rules:
- Prompts go through stdin or files, never argv. Cursor is the one exception.
- `CI` is removed from the environment. It would force Gemini into headless mode, and it changes the behavior of the other CLIs too.

### 4.2 Claude Code (`claude-cli`)

**Discovery**
- **Binary names:** `claude`.
- **Known directories:** `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, and the npm global bin.
- **Versions:** minimum `2.1.260`, verified range `2.1.260–2.1.260`.

**Probes**
- **Version:** `claude --version`, which prints `2.1.260 (Claude Code)`. Timeout 10 s.
- **Auth:** `claude auth status --json`, timeout 10 s.
  - Keep only `loggedIn`, `authMethod`, `apiProvider` and `subscriptionType`. Drop every other key **before** logging or storing anything: `email`, `org*` and the rest.
  - Result mapping (the first matching row wins):

    | Condition | `state` | `billing` | `plan` |
    |---|---|---|---|
    | not `loggedIn` | `logged_out` | — | — |
    | `apiProvider !== "firstParty"` | `unknown` | — | — |
    | `authMethod === "claude.ai"` | `logged_in` | `subscription` | `subscriptionType` |
    | any other `authMethod` | `logged_in` | `metered` | — |

  - For the `unknown` case the detail reads "configured for Bedrock/Vertex/Foundry via settings, which the app's restricted mode ignores; see Settings → Details".

**Lockdown checks** (from `--help`):
- flags: `--tools`, `--mcp-config`, `--strict-mcp-config`, `--restricted`, `--disable-slash-commands`, `--no-session-persistence`, `--allowedTools`, `--json-schema`, `--input-format`, `--settings`;
- `--permission-mode` choices include `dontAsk`;
- version ≥ 2.1.260.

`--max-turns` and `--system-prompt-file` are hidden flags. If a future version removes them, the spawn fails with an unknown-option error. We map that to `unsupported` and re-detect, so the failure is closed.

**Files written to the workspace**

| File | Mode | Content |
|---|---|---|
| `claude-settings.json` | 0400 | `{"disableAllHooks": true, "autoMemoryEnabled": false}` |
| `mcp.json` | 0400 | Completion: `{"mcpServers":{}}`. Runtime: `{"mcpServers":{"cad":{"type":"stdio","command":<shim.command>,"args":<shim.args>,"env":{"AICAD_MCP_BRIDGE":<socket>,...shim.env}}}}`. There is **no ticket here**. The shim inherits `AICAD_MCP_TICKET` from Claude's environment (V-here: the MCP child inherits the CLI's environment). |
| `system.md` | 0400 | The system prompt. |

**Completion command**
```
claude -p --output-format stream-json --verbose --input-format text
  --model=<cli.modelArg> [--effort=<cli.effortArg[effort]>]   (only when --help lists --effort; else a warning)
  --restricted --disable-slash-commands --settings <ws>/claude-settings.json
  --tools "" --strict-mcp-config --mcp-config <ws>/mcp.json
  --permission-mode dontAsk --no-session-persistence --max-turns 3
  --system-prompt-file <ws>/system.md
  [--json-schema '<envelope schema JSON>']
stdin: the rendered transcript, then EOF.
```
If the turn includes images, use `--input-format stream-json` and send one user message with image blocks, then EOF.

**Runtime command**
```
claude -p --input-format stream-json --output-format stream-json --verbose
  --model=… [--effort=…]
  --restricted --disable-slash-commands --settings <ws>/claude-settings.json
  --tools "" --strict-mcp-config --mcp-config <ws>/mcp.json
  --permission-mode dontAsk --allowedTools mcp__cad
  --no-session-persistence --max-turns <limits.maxTurns>
  [--max-budget-usd <remaining notional cap>]
  --system-prompt-file <ws>/system.md
stdin: {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}\n
       One line per user message. closeInput() ends the process after the current turn.
```

**Extra environment**

| Variable | Modes | Value |
|---|---|---|
| `DISABLE_AUTOUPDATER` | both | `1` |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | both | `1` |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | both | `1` |
| `MCP_TOOL_TIMEOUT` | runtime | `900000` |
| `AICAD_MCP_TICKET` | runtime, and `mcp-submit` | the ticket |

**Parsing**

| CLI event | `CliEvent` |
|---|---|
| `system/init` | `init`, with `tools`, `mcp_servers`, `model`, `session_id` and `claude_code_version` |
| `rate_limit_event` | `plan_usage` |
| `assistant` blocks, aggregated by `message.id` | `text` (whole block), `tool_call` (`mcp__cad__*`) or `structured` (`StructuredOutput` input). A `thinking` block is dropped. When a new message starts, or a `user` / `result` event arrives, a `turn` is emitted with the last `usage`. |
| `user` `tool_result` | `tool_result` |
| `system/thinking_tokens` | ignored |
| `result` | `result`. `costUsd` = `total_cost_usd`; `models` = the `modelUsage` keys; reasoning tokens = the sum of `thinkingTokens`. |
| unknown `type` | ignored |

**Failure mapping**

| Signal | Failure |
|---|---|
| `result.subtype` `error_max_turns` | `max_turns` |
| `error_max_budget_usd` | `budget` |
| `error_max_structured_output_retries` | `bad_output` |
| `error_during_execution` with `api_error_status` 429 | `rate_limited` |
| `rate_limit_event.status === "rejected"` | `quota_exhausted`, with `resetsAt` |
| Non-zero exit with no `result` | `not_logged_in` when stderr matches the recorded login-failure texts (§15), otherwise `crashed` |
| Unknown option on stderr | `unsupported` |

**Other**
- **Cleanup:** none needed.
- **Plan usage:** forwarded to the host (`onPlanUsage`). The host caches the last value per provider.

### 4.3 Gemini CLI (`gemini-cli`)

**Discovery**
- **Binary names:** `gemini`. It is a Node script, so the child `PATH` must contain the `node` next to it (§5.3).
- **Versions:** minimum `0.49.0`, verified range `0.49.0–0.49.x` (offline). Newer versions run at level `static` (§5.5).

**Probes**
- **Version:** `gemini --version`.
- **Auth** (probe `settings-field`):
  - Parse `~/.gemini/settings.json` and read **only** `security.auth.selectedType`.
  - Check whether `~/.gemini/oauth_creds.json` **exists**. Never read it.
  - Result mapping:

    | `selectedType` | Creds file | `state` |
    |---|---|---|
    | `oauth-personal` | present | `logged_in` |
    | `oauth-personal` | absent | `unknown` (the credentials may be in the keychain) |
    | missing | — | `logged_out` |
    | `gemini-api-key`, `vertex-ai`, … | — | `unknown` |

  - For the last row the detail reads "API-key / Vertex auth is not forwarded to CLIs; use the Google API provider instead".

**Workspace**
- The basename is always `aicad-run`, under a random parent. **Amended (§15 G4, real binary):** Gemini keys sessions by the full project path, not the basename. Each run registers a new slug (`aicad-run`, `aicad-run-1`, ...) in `~/.gemini/projects.json` and keeps a small `~/.gemini/tmp/<slug>/` and `~/.gemini/history/<slug>/` folder. After cleanup these hold only the workspace path (`.project_root`), no prompt text (§5.9).

**Files**

`.gemini/settings.json` (0400):
```json
{
  "tools": { "core": ["mcp_cad_<tool>", "..."] },
  "mcp": { "allowed": ["cad"] },
  "mcpServers": { "cad": { "command": "<shim.command>", "args": ["<shim.args>"],
      "env": { "AICAD_MCP_BRIDGE": "<socket>", "AICAD_MCP_TICKET": "$AICAD_MCP_TICKET" },
      "trust": true, "timeout": 900000, "includeTools": ["<tool>", "..."] } },
  "advanced": { "ignoreLocalEnv": true },
  "hooksConfig": { "enabled": false },
  "context": { "fileName": ["AICAD_NO_CONTEXT_<runId hex>.md"] },
  "general": { "maxAttempts": 3 },
  "model": { "maxSessionTurns": "<limits.maxTurns>" },
  "billing": { "overageStrategy": "never" }
}
```
- **Completion with `text-json`:** `tools.core: []`, which disables every tool (V-research), and no `mcpServers`.
- **Completion with `mcp-submit`:** `tools.core: ["mcp_cad_submit_turn"]`.
- **The ticket name** has no `TOKEN`, `KEY`, `SECRET`, `AUTH` or `CREDENTIAL` substring, so Gemini's env redaction does not remove it. It is passed explicitly anyway.
- **The context file name** is per run and unguessable (`geminiContextFileName(runId)`). A public fixed name would let a file planted in any parent folder add instructions, because Gemini looks for it upward from the workspace (§5.4).

`policy.toml` (0400), passed with `--policy`:
```toml
[[rule]]
toolName = "*"
decision = "deny"
priority = 100

[[rule]]
mcpName = "cad"
toolName = "*"
decision = "allow"
priority = 500
```

`system.md` (0400). `${` is escaped, because Gemini substitutes `${…}` placeholders in this file (§15).

**Command**
```
gemini -p "Follow the instructions in the message above." -o stream-json --model=<cli.modelArg>
  --extensions=none --approval-mode default --skip-trust --policy <ws>/policy.toml --allowed-mcp-server-names cad
  (--session-id=<geminiSessionId(runId)> | --resume=<sessionId>)
stdin: neutralizeAtPaths(prompt), then EOF. Gemini prepends it to the -p text.
```
- **Values are passed as `--flag=value`** and validated (§5.7), so a model or session id can never be read as a flag. The lockdown therefore requires the long forms `--model` and `--resume`.
- **Hooks and extensions are off (amended, review round 2).** Hooks are arbitrary shell commands that receive the prompt, the design text and tool arguments, and `hooksConfig.enabled` defaults to `true`: without the switch, the real 0.49.0 binary ran the user's `SessionStart`, `BeforeAgent` and `BeforeModel` hooks and an installed extension's hooks, and the extension's context file reached the request. The workspace settings set `hooksConfig.enabled: false`; `--extensions=none` (`=` form, followed by a flag, so it is never read as more array values) keeps every extension out: its hooks, context file, MCP servers, skills and agents. The lockdown requires `--extensions`. Verified with the real binary, a control included (`real-gemini.test.ts`, T2).
- **`geminiSessionId(runId)`** is the run's UUID with its first hex digit mapped to a letter (`3b24…` → `db24…`). It can never parse as a number (see Cleanup), and its first 8 characters contain no `-`: Gemini 0.49 names the session file after them and refuses to delete a session otherwise (real binary).

**Extra environment**

| Variable | Value |
|---|---|
| `GEMINI_CLI_TRUST_WORKSPACE` | `true` (needed to load the workspace settings) |
| `GEMINI_SYSTEM_MD` | `<abs ws>/system.md` |
| `NO_BROWSER` | `true` |
| `AICAD_MCP_TICKET` | the ticket |

**Parsing**

| Gemini event | `CliEvent` |
|---|---|
| `init` | `init` (no tool list) |
| `message` (role `assistant`) | `text` delta |
| `tool_use` | `tool_call` |
| `tool_result` | `tool_result`; `unavailable: true` when `status` is `error` and `error.type` is `tool_not_registered` (Gemini's own refusal of a name it has no tool for, §5.6 amendment 2) |
| `error` (severity `warning`) | `warning` |
| `error` (severity `error`) | `retry` or `warning` |
| `result` | `result`. Usage comes from `stats`: `input` is uncached input, and `cached` is cache reads. `output_tokens` counts candidates only, so thinking tokens are `total_tokens − input_tokens − output_tokens`; they are added to `outputTokens` and reported as `reasoningTokens`. The model list is the `stats.models` keys, never `init.model`. The result `text` is the assistant text since the last tool activity (Gemini's own result event carries none). |

A model turn is the span between the first assistant delta and the next `tool_use` or `result`. Gemini emits the `turn` after that turn's text, so the final text is never taken "since the last `turn`" (`finalAssistantText`, §7.8).

**Failure mapping**

| Signal | Failure |
|---|---|
| Exit 41 | `not_logged_in` |
| Exit 42 or 52 | `unsupported` |
| Exit 53 | `max_turns` |
| Exit 55 | `unsupported` (trust not applied) |
| Exit 130 | `cancelled` |
| `result.error.type` `TerminalQuotaError` | `quota_exhausted` |
| `RetryableQuotaError`, or text containing 429 / `RESOURCE_EXHAUSTED` | `rate_limited` |
| Exit 0 with `result.status === "error"` | `bad_output` |
| Non-zero exit with no `result` line | parse the plain-text stderr |

**Other**
- **Cleanup:** `gemini --extensions=none --delete-session=<sessionId>`, run in the invocation's **own** workspace directory before it is disposed (sessions are keyed by the full path, §15 G4, verified). Rules:
  - only a session id the CLI reported (`init`/`result`) is deleted, never the run id as a guess;
  - only an id that does not parse as a number: when no session has the id, Gemini 0.49 falls back to `parseInt(id)` as a 1-based **index** and would delete an unrelated session;
  - only when `--help` lists `--delete-session`;
  - `--list-sessions` is **not** used to confirm: it refreshes auth and may generate session summaries, which is a model call.
  - Retention (30 days) is the fallback, and the residual risk says so (§5.9).
  - The command runs without workspace trust (so the `cad` server is not configured), which also means the workspace `hooksConfig` does not apply: `--extensions=none` keeps extensions out, and the real binary fired no hook for it (verified).
  - **Growth (amended, review round 2):** every run still adds a project entry to `~/.gemini/projects.json` (the workspace path), two `~/.gemini/{tmp,history}/aicad-run-<n>/.project_root` folders and an empty `projects.json.<uuid>.tmp` file. Measured on 0.49.0: about 0.5 KB and two folders per run, never removed by Gemini. Accepted and disclosed (§5.9); a stable per-host workspace path would bound it and is future work.
- **Continuation:** `--resume=<sessionId>` in a new process, with the nudge as the prompt.

**Caveats**
- **`@path` expansion (§15 G2, verified on 0.49.0).** Gemini expands `@path` **anywhere** in the headless prompt: its parser is a plain regex, and code fences are not special. It reads the file into the request when the path is inside a workspace directory, and `context.includeDirectories` from the user's settings counts (it merges by concatenation, so our workspace settings cannot clear it). The real-binary replay shows a fenced `@<included dir>/secret.txt` being read.
  - So `GeminiCliProvider.buildArgs` passes **every** prompt, in every mode, through `neutralizeAtPaths()`, which puts a zero-width joiner after **every** `@`, fences included. It is idempotent.
  - `restoreAtPaths()` undoes it in what comes back: the adapter applies it to envelopes and plain text, and the runtime broker must apply it to Gemini's MCP tool arguments (`@aicad/std` in `apply_cadscript` code).
  - Runtime prompts still carry no file text; the model reads the code with `get_code`.
- The workspace listing in `<session_context>` also lists the files of every `includeDirectories` folder (names only).
- The user's global `~/.gemini/GEMINI.md` is still loaded whatever `context.fileName` says (verified), and a `<session_context>` block lists the (empty) workspace. Both are privacy and token costs, not capability risks. A `GEMINI.md` or old-name context file planted in a parent folder is **not** loaded (verified).

### 4.4 Codex CLI (`codex-cli`), from source and docs only

**Discovery**
- **Binary names:** `codex`.
- **Versions:** minimum `0.156.1`, verified range `null`, so the level is `static` (§5.5). The provider cannot reach `verified` until someone with a ChatGPT plan runs the smoke (§15). The lockdown requires the long form `--model`: the model is passed as `--model=<m>`.

**Probes**
- **Version:** `codex --version`, which prints `codex-cli <ver>`.
- **Auth:** `codex login status`.
  - Exit 0 means `logged_in`. Map the stderr phrase to a method: "using ChatGPT" gives `subscription`; "using an API key" and "access token" give `metered`.
  - Discard the masked key.
  - Exit 1 means `logged_out`.

**Lockdown checks**
- `codex exec --help` lists `--json`, `--output-schema`, `--ephemeral`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `--strict-config`, `--sandbox`, `--cd` and `--config`.
- With `--strict-config`, an unknown `-c` key makes the run fail. So a renamed lockdown key **fails closed** [SRC].

**Completion command**
```
codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules --strict-config
  -C <ws> -s read-only
  [--model=<cli.modelArg>] [-c model_reasoning_effort="<effortArg>"]
  -c features.shell_tool=false -c web_search="disabled" -c features.multi_agent=false -c tools.view_image=false
  -c model_instructions_file="<ws>/system.md"
  [--output-schema <ws>/envelope.schema.json]
  -
stdin: the prompt, then EOF. Never leave stdin open (issue #20919).
```

**Runtime command**
- Not ephemeral, so that `resume` works.
- The session is deleted afterwards with `codex delete <thread_id>` [DOCS; argument shape per §15 X2], **only when `codex --help` lists a `delete` command**, so an unknown subcommand is never parsed as something else. Otherwise the session stays in `~/.codex/sessions` (§5.9).
- The command adds:
```
  -c mcp_servers.cad.command="<shim.command>" -c 'mcp_servers.cad.args=[…]'
  -c mcp_servers.cad.env.AICAD_MCP_BRIDGE="<socket>" -c 'mcp_servers.cad.env_vars=["AICAD_MCP_TICKET"]'
  -c mcp_servers.cad.required=true -c mcp_servers.cad.default_tools_approval_mode="approve"
  -c 'mcp_servers.cad.enabled_tools=[…]' -c mcp_servers.cad.tool_timeout_sec=900 -c mcp_servers.cad.startup_timeout_sec=20
```
- **Continuation:** `codex exec <same pre-resume flags> resume <thread_id> --json -`. `-s`, `-C` and `--profile` must come **before** `resume`.
- **Images:** `-i <file> -`, with the prompt on stdin. `-i` is greedy (#40545).

**Parsing**

| Codex event | `CliEvent` |
|---|---|
| `thread.started` | `init` (with the session id) |
| `item.completed` `agent_message` | `text`, or `structured` when `--output-schema` is set |
| `item.*` `mcp_tool_call` (server `cad`) | `tool_call` and `tool_result` |
| `reasoning` | `reasoning` |
| `error` item | `warning` |
| `error` event "Reconnecting…" | `retry` |
| `turn.completed.usage` | `turn` usage. The value is cumulative per thread, so diff it against the last total. `inputTokens = input − cached`. |
| `turn.failed` | `result` with `ok: false` |

**Tripwire items (allowlist, fails closed):** only `agent_message`, `reasoning`, `mcp_tool_call` (server `cad`), `todo_list` and `error` items are expected. **Every other item type** becomes a `builtin_activity` tool call at its first sighting (`item.started` when Codex sends one): `command_execution`, `file_change`, `web_search`, `collab_tool_call`, and anything a later Codex adds or renames. An `mcp_tool_call` whose server is not `cad` also trips.

**Failure mapping** (by message text; match "hit your usage limit" so the curly-apostrophe variants also match):

| Text | Failure |
|---|---|
| "hit your usage limit" | `quota_exhausted` (parse the "Try again at" time) |
| "rate limit exceeded" | `rate_limited` |
| "Quota exceeded" | `quota_exhausted` |
| "ran out of room in the model's context window" | `context_overflow` |
| "required MCP servers failed to initialize" | `crashed` |

### 4.5 opencode (`opencode`)

**Discovery**
- **Binary names:** `opencode`.
- **Versions:** minimum `1.17.10`, verified range `1.17.10–1.17.x` (mock provider).

**Probes**
- **Version:** `opencode --version`.
- **Auth:** `opencode models`, with `OPENCODE_DISABLE_MODELS_FETCH=1`.
  - A provider other than the free `opencode` (Zen) provider means `logged_in`.
  - Zen only means `logged_in` with plan `"free models only"`. The UI warns that free models may have different data terms.
- **MCP servers:** `opencode mcp list` gives the names of the user's MCP servers. We turn each one off per run (see the config below). **Amended (review round 2):** only the per-server lines count (`●  <status glyph> <name> <status>` on 1.17.10); the empty-list text (`No MCP servers configured`, `Add servers with: …`) and anything else yield no name. Recorded fixtures: `test/cli/fixtures/opencode/mcp-list-1.17.10-{empty,servers}.txt`.

**Lockdown checks**
- `run --help` lists `--format`, `--agent`, `--title`, `--model`, `--session`, `--print-logs` and `--log-level`. Values are passed as `--model=`, `--session=` and `--variant=` (§5.7).
- `--variant` is optional, not a lockdown flag: it is passed only when `run --help` lists it; otherwise the effort is dropped with a warning (amended, review round 2). Claude's `--effort` follows the same rule.
- `OPENCODE_CONFIG_CONTENT` is supported.
- Add `--pure` when `run --help` lists it. Verified on 1.17.10 (§15 O2): it keeps the user's global plugins (`~/.config/opencode/plugin{,s}/`) from loading. The probes (`mcp list`, `models`) and cleanup pass it too.
- **`OPENCODE_DISABLE_PROJECT_CONFIG=1`** on every run, probe and cleanup (§5.4). Without a git repo, opencode reads `opencode.json`, `.opencode/` (agents, commands, plugins, MCP servers) and `AGENTS.md` from the working directory **and every folder above it**, up to `/`. A file planted in a shared parent could start processes and add instructions. With the variable set, a planted config is not loaded (verified with the real binary: `test/cli/real-opencode.test.ts`, including a control that shows it IS loaded without the variable).

**`OPENCODE_CONFIG_CONTENT`** (JSON, per run; never written to disk):
```json
{
  "autoupdate": false,
  "share": "disabled",
  "permission": { "*": "deny", "cad_*": "allow" },
  "agent": { "aicad": { "mode": "primary", "prompt": "{file:<ws>/system.md}",
                        "permission": { "*": "deny", "cad_*": "allow" } } },
  "mcp": {
    "cad": { "type": "local", "command": ["<shim.command>", "<shim.args…>"],
             "environment": { "AICAD_MCP_BRIDGE": "<socket>", "AICAD_MCP_TICKET": "{env:AICAD_MCP_TICKET}" },
             "enabled": true, "timeout": 20000 },
    "<each user server name>": { "enabled": false }
  }
}
```
In completion mode the config has no `mcp.cad`, except for `mcp-submit`, where only `cad_submit_turn` is allowed.

**Command**
```
opencode run --format json --agent aicad --title aicad [--model=<provider/model>] [--variant=<effortArg>]
  [--session=<sessionId>] [--pure] --print-logs --log-level ERROR "Follow the instructions in the message below."
stdin: the prompt, then EOF. It is appended after the message.
```
The workspace is the working directory.

**Extra environment:** `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_AUTOUPDATE=1` and `AICAD_MCP_TICKET`.

**Parsing**

| opencode event | `CliEvent` |
|---|---|
| `step_start` | a model turn begins |
| `text` | `text` (whole part) |
| `tool_use` | `tool_call` at the **first** sighting of a call id (pending, running or finished), so a tripwire kill comes as early as the stream allows; `tool_result` when it is completed or errored, with `unavailable: true` when the error starts `Model tried to call unavailable tool '…'` (opencode's own refusal of a name it has no tool for; it reports the original name in `part.tool`, real binary) |
| `step_finish` | `turn`, with `part.tokens` and `part.cost`. A **final** step with `reason: "length"` is a truncated reply: `ok`, the turn says `max_tokens`, plus a warning; `content-filter` is a `refusal` (amended, review round 2; before, both fell through to "the CLI exited without a result") |
| `error` | `warning` or a failure, by `error.name`: `APIError` + `statusCode` 401 gives `not_logged_in`; `ContextOverflowError` gives a warning, because opencode compacts itself |
| process exit | `result` (there is no result event) |

- **Exit code:** exit 1 **after** a final `step_finish` with `reason: "stop"` and a valid envelope counts as success with a warning. opencode exits 1 after any recovered error. The parser clears an earlier failure (for example a retried 429) when a later step finishes with `stop`, and keeps the error as a warning; an error **after** the last `stop` step still fails the run.
- **Silent retries:** `--print-logs --log-level ERROR` sends error logs to stderr. A line with `AI_APICallError` and a 429 or quota text gives `rate_limited`. The stall timer backs this up.
- **Cleanup:** `opencode session delete <id> --pure` (verified on 1.17.10 with the real binary).

**Caveats**
- Claude Pro/Max logins cannot be used through opencode; the vendor forbids it [DOCS]. opencode profiles never route to Anthropic OAuth.
- The user's own opencode plugins run in-process unless `--pure` turns them off (§5.9). `--pure` is on whenever `run --help` lists it.

### 4.6 Cursor Agent (`cursor-agent`): the adapter ships blocked

**Discovery and probes**
- **Binary names:** `cursor-agent`, `agent`.
- **Versions:** the minimum is the first build that has `--trust` and `status --format json` (§15 item C1). Verified range `null`.
- **Auth:** `cursor-agent status --format json` on newer builds. Otherwise parse `status` text, where `Not logged in` exits 0.

**Why it is blocked.** `lockdown().ok` is `false` on every build until a maintainer verifies one:
- Server-side web search has no documented off switch, and headless mode auto-approves it.
- Whether a `deny` rule hides built-in tools from the model is unverified.
- The installed 2026.01.28 build has no `--trust`.
- `--approve-mcps` would also start the user's global MCP servers. On this machine those are supabase, stripe, Neon, shadcn and ref.

**Planned spec, used once it is unblocked.** Frozen now so the adapter can be written and offline-tested.

Files:
- `<ws>/.cursor/cli.json`: `{"permissions":{"allow":["Mcp(cad:*)"],"deny":["Shell(*)","Read(**)","Write(**)","WebFetch(*)"]}}`
- `<ws>/.cursor/mcp.json`: `{"mcpServers":{"cad":{"command":…,"args":…,"env":{"AICAD_MCP_BRIDGE":…,"AICAD_MCP_TICKET":"${env:AICAD_MCP_TICKET}"}}}}`

Pre-step: run `cursor-agent mcp enable cad` with the working directory set to the workspace.

Command:
```
cursor-agent -p --output-format stream-json --workspace <ws> --trust --sandbox enabled [--model=<slug>] "<prompt>"
```
- **Never pass:** `--force`, `--yolo`, `--approve-mcps`, `--printenv` (it dumps the whole environment into events), `--api-key`, `-H`.
- **Prompt size:** the prompt goes through argv and is capped at 96 KiB. Cursor is not supported on Windows (command-line limit).
- **Tripwire:** any `tool_call` key other than `mcpToolCall`, or an `mcpToolCall` whose `providerIdentifier` is not `cad`.

---

## 5. Security

### 5.1 Threats

| # | Threat |
|---|---|
| T1 | The model uses a CLI's **built-in tools** to read or modify user files, run commands, or leak the design to the web. It may be prompt-injected by text in the user's file. |
| T2 | **User or project CLI configuration** adds capabilities to our runs: hooks, plugins, MCP servers, permission allow-rules, memory and rules files, `.env` files. |
| T3 | **Secret leakage.** Keys or tokens reach the CLI or its children, or show up in logs, events or argv. |
| T4 | **Runaway resources.** Loops, silent retries, hung processes, and disk filling up with sessions and crash reports. |
| T5 | **Untrusted output.** Huge or malformed JSONL, control sequences, forged events, spoofed tool calls. |
| T6 | **Local observers.** Other local users read argv, or connect to our broker. |
| T7 | **Binary spoofing.** A different `claude` found earlier in `PATH`, or placed in the working directory. |
| T8 | **Drift.** A CLI update silently turns tools back on or changes flags. |

### 5.2 Layers (all mandatory)

| Layer | Control | Threats |
|---|---|---|
| L1 Tool lockdown | The per-CLI flags and config in §4 remove every built-in tool from the model's toolset | T1 |
| L2 Config isolation | Strict MCP config with only `cad` (Claude `--strict-mcp-config`; Codex `--ignore-user-config`; Gemini `mcp.allowed` + `tools.core`; opencode deny-all + user servers disabled; Cursor workspace-only). Claude `--restricted` ignores the user's, project's and local settings files. Hooks, auto-memory and `CLAUDE.md` are off (Gemini: `hooksConfig.enabled: false` + `--extensions=none`, amended review round 2). | T1, T2 |
| L3 Filesystem | A fresh, empty `0700` workspace per invocation (§5.4). No user file is ever placed there: code reaches the model through the transcript or through `get_code`. `TMPDIR` points into the workspace. | T1, T4 |
| L4 OS sandbox, where offered | Codex `-s read-only`; Cursor `--sandbox enabled`. Not Gemini's sandbox: it relaunches the whole CLI and could block our socket. | T1 |
| L5 Environment | Allowlist, a deny pattern, forced values (§5.3). No credential variable is ever forwarded. | T3 |
| L6 Capability broker | Our MCP server is the only capability. It is scoped per phase, needs a ticket, is rate-limited and serialized, and refuses everything after a stop (§6). | T1, T4 |
| L7 Tripwires | Runtime checks of `init` tool lists and every tool call. A violation kills the run immediately (§5.6). | T1, T2, T8 |
| L8 Version gate | Lockdown report per binary, re-checked whenever the binary changes. Unsupported or blocked versions are refused, with no override (§5.5). | T8 |
| L9 Output handling | Size caps, strict parsing, never executed, never rendered as markup (§5.7). | T5 |
| L10 Process control | Own process group, stdin discipline, wall, stall and start timeouts, tree kill, cleanup on quit (§5.8). | T4 |
| L11 Binary resolution | Absolute real paths only. Relative and `.` entries in `PATH` are ignored, and nothing is ever run from a workspace. The resolved path is shown in Settings, and the worker re-stats it before spawning. | T7 |
| L12 No argv secrets | The ticket and prompts never go through argv, except Cursor's prompt (§4.6). | T3, T6 |

### 5.3 Environment (frozen: `packages/llm-gateway/src/cli/env.ts`)

```ts
/** Inherited from the host when present (the desktop worker's env is already allowlisted: env.ts CHILD_ENV_ALLOWLIST). */
export const CLI_ENV_BASE: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC", "TZ",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
];
/** Where a CLI keeps its own login and config. Never credential values. */
export const CLI_ENV_LOCATION: readonly string[] = [
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME",
];
/** Needed behind corporate proxies. May embed proxy credentials: forwarded, never logged. */
export const CLI_ENV_NETWORK: readonly string[] = [
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];
/** Applied to every inherited name except CLI_ENV_NETWORK. A match is dropped even if listed above. */
export const CLI_ENV_DENY = /(API_?KEY|TOKEN|SECRET|PASSW|CREDENTIAL|COOKIE|PRIVATE|(^|_)AUTH($|_))/i;

export interface CliEnvOptions {
  tmpDir: string;             // workspace.tmp
  binaryDir: string;          // dirname(binary.realPath), prepended to PATH
  nodeDir?: string;           // for Node-script CLIs (gemini, npm-installed codex/opencode)
  extra: Readonly<Record<string, string>>;   // provider-documented non-secret vars + AICAD_MCP_TICKET / AICAD_MCP_BRIDGE
}
export function cliChildEnv(parent: Readonly<Record<string, string | undefined>>, options: CliEnvOptions): Record<string, string>;
```

**Forced values:**
- `TMPDIR`, `TEMP` and `TMP` = `workspace.tmp`;
- `NO_COLOR=1`, `FORCE_COLOR=0`, `TERM=dumb`;
- `NO_BROWSER=true` and `NO_OPEN_BROWSER=1`, so a headless run never opens a login page.

**Always removed:**
- `CI` and `GITHUB_ACTIONS`;
- `NODE_OPTIONS`;
- `ELECTRON_RUN_AS_NODE` (it is re-added only inside the shim's MCP env);
- every `CLAUDE_CODE_*` and `CLAUDECODE` inherited from the host (this matters when the app itself runs under Claude Code during development);
- `ANTHROPIC_*`, `OPENAI_*`, `GEMINI_*` (except `GEMINI_CLI_HOME`), `GOOGLE_*`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `CURSOR_API_KEY`.

Provider extras (`CliEnvOptions.extra`) are applied last. They are the only way a `GEMINI_*`, `CLAUDE_CODE_*`, `OPENCODE_*` or `AICAD_MCP_*` value enters the environment.

`PATH` becomes: `binaryDir`, then `nodeDir`, then the host `PATH` with relative entries removed.

**Consequence for users.** A CLI that is authenticated **only** through an environment key (for example Gemini with `GEMINI_API_KEY`) shows `unknown` or `logged_out`. The UI points the user to the matching API provider instead.

**Desktop.** The worker is forked with `agentWorkerEnv(env, [...CLI_ENV_LOCATION, ...CLI_ENV_NETWORK])`. `CLI_ENV_BASE` is already covered by `CHILD_ENV_ALLOWLIST`.

### 5.4 Workspace (frozen: `cli/workspace.ts`)

```ts
export interface CliWorkspace {
  readonly dir: string;        // CLI cwd; empty except the files the provider writes
  readonly tmp: string;        // <dir>/.tmp, the CLI's TMPDIR (Gemini crash reports land here)
  readonly socketDir: string;  // short path for the broker socket (macOS sun_path ≤ 103 bytes)
  write(relPath: string, content: string, mode?: 0o400 | 0o600): string;   // refuses "..", absolute paths, symlinks
  dispose(): Promise<void>;    // rm -rf dir and socketDir unless keep
}
export function createCliWorkspace(options: { root?: string; runId: string; keep?: boolean; basename?: string }): Promise<CliWorkspace>;
```

- **Location.**
  - **Amended (review, 2026-09-24).** Every ancestor of the root must be private: a directory owned by the user or root, and not writable by group or others. A sticky `/tmp` does not count as private, because others can still create files there. The reason: CLIs discover config and context files **upward** from their working directory. opencode reads `opencode.json`, `.opencode/` and `AGENTS.md` up to `/` when there is no git repo, and Gemini looks for its context file name the same way. A workspace under a shared `/tmp` (Linux) would let another local user plant a file that starts processes or adds instructions. `unsafeAncestor(path)` implements the check.
  - The default root is the first private choice among:
    1. `setDefaultWorkspaceRoot(root)`, which the host should set to its own folder (Electron `userData/cli-work`);
    2. `realpath(os.tmpdir())/aicad-cli/` when the temp dir is per-user (macOS `/var/folders/…`, Windows `%TEMP%`);
    3. `$XDG_RUNTIME_DIR/aicad-cli`;
    4. the user cache dir (`~/Library/Caches`, `%LOCALAPPDATA%`, `$XDG_CACHE_HOME` or `~/.cache`) + `/aicad-cli`.
  - Detection probes (`--version`, `--help`, `mcp list`, `models`) run in a fresh private directory under the same root (`createProbeDir()`), never in `os.tmpdir()`.
  - Per-CLI defenses do not depend on the root alone: opencode runs with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, and Gemini gets a per-run, unguessable context file name.
  - The root has mode 0700 and is owned by the user. The directory is `<root>/<16 hex>/<basename ?? "w">`.
  - The socket directory is `<root>/s/<8 hex>`. On Windows the endpoint is the named pipe `\\.\pipe\aicad-mcp-<16 hex>`.
- **Startup sweep.** On worker start, directories under the root older than 24 h are deleted.
- **`keep`** exists for debugging only. Kept files are secret-scrubbed, and the ticket is never written to disk.

### 5.5 Lockdown checks and refusal policy (frozen)

`CliProvider.lockdown(binary)` is pure. It reads the version and the parsed `--help` output. Its levels:

| Level | Meaning | Allowed? |
|---|---|---|
| `verified` | Version inside `verifiedRange`, **and** every required check passes. A maintainer has run the §13.3 smoke (or, for Gemini and opencode, the offline harness) on this range. | Yes |
| `static` | Version ≥ `minVersion` but outside the verified range, **and** every required flag and config mechanism is present. Relies on the runtime tripwires. | Yes, with a warning in Settings |
| `none` | A required check fails, the version is below the minimum, or the provider is on the block list. | **No: refused** |

**Refusal (frozen):**
- `detection.status` must be `ready` before any invocation. `AgentHost.start` answers otherwise:
  - `CLI_NOT_INSTALLED`: not found;
  - `CLI_UNSUPPORTED`: the version is below the minimum;
  - `CLI_BLOCKED`: lockdown `none`, or a tripwire fired on this binary;
  - `CLI_NOT_LOGGED_IN`: auth is `logged_out`.
- There is **no user override**.
- `unknown` auth is allowed. The run fails fast with `not_logged_in` if needed.

**Enforced twice (amended, review 2026-09-24).** `binaryRefusal(provider, binary)` refuses a binary for another provider, a binary that changed or vanished since detection, a version below the minimum, and lockdown level `none`. Both `CliTransport` and `BaseCliProvider.run()` apply it, so a host that calls `provider.run()` directly (the runtime driver) cannot skip it. `run()` also refuses flag-like argv values (§5.7). A refused run ends with `reason: "spawn_failed"` and `unsupported` (or `not_installed`), and nothing is written or spawned.

**Re-check.**
- Detection is cached, keyed by `realPath` + `size` + `mtimeMs`. It is recomputed whenever those change; CLIs auto-update.
- A tripwire marks that exact binary `blocked` until the user presses **Re-check** and the checks pass again.

### 5.6 Runtime tripwires (frozen: `cli/lockdown.ts`)

```ts
export interface TripwireContext {
  allowed: ReadonlySet<string>;        // qualified names of the phase's tools (+ submit_turn when used)
  structuredToolName: string | null;   // "StructuredOutput" for Claude json-schema
  expectMcp: "none" | "cad";
  reportedTools?: ReadonlySet<string> | null;   // (amendment 2) the init tool list once it passed the init check (Claude)
  builtinTools?: ReadonlySet<string> | null;    // (amendment 2) the CLI's built-in names (Gemini, opencode); null = fail closed
}
export function tripwire(event: CliEvent, ctx: TripwireContext): LockdownViolation | null;   // pure, per event
export class TripwireMonitor {                                      // (amendment 2) stateful; BaseCliProvider.run() uses it
  constructor(ctx: TripwireContext);
  observe(event: CliEvent): { violation: LockdownViolation | null; warnings: string[] };
  finish(): LockdownViolation | null;                               // held calls never answered = violation (fail closed)
}
export interface LockdownViolation { kind: "unexpected_tool" | "unexpected_mcp_server" | "mcp_not_connected" | "builtin_activity"; detail: string }
```

The checks:
- **`init` with a tool list (Claude):** every tool must be in `allowed ∪ {structuredToolName}`. `mcpServers` must equal `[]` or `[{name:"cad", status:"connected"}]`, whichever `expectMcp` says. This check runs **before the first model call**.
- **Every `tool_call`:** the qualified name must be in `allowed`, or the CLI must provably be unable to run it (amendment 2, below).
- **Built-in activity markers:** Codex: any item type other than `agent_message`, `reasoning`, `mcp_tool_call`, `todo_list` and `error` (an allowlist, so a new or renamed built-in fails closed); Cursor non-MCP `tool_call` keys; Gemini and opencode tool names outside `allowed`, even when they errored. opencode calls count at their first sighting (pending or running when opencode reports those).

**Tripwires detect; they do not prevent (amended, review 2026-09-24).** A tripwire sees a built-in tool call only after the CLI reported it:
- opencode reports a call once it is pending, running or finished, so a fast built-in tool may have run already;
- for Gemini and Codex, the kill races the tool's execution;
- only Claude reports its tool list at `init`, **before** the first model call. Nothing checks up front what Gemini, Codex or opencode expose to the model.

The **prevention** layers are the lockdowns themselves: `tools.core` + the deny-all policy (Gemini), `-c` feature switches + `--strict-config` + the read-only sandbox (Codex), and the deny-all permission (opencode, which removes built-ins from the model's tool list; verified with the real binary). The real-binary harnesses (§13.1) check the tool list for Gemini and opencode. The residual risks say this for each CLI (§5.9).

**On a violation:**
1. `cancel(run, "lockdown")` immediately.
2. `CliFailure {code: "lockdown_violation"}`. `kill("lockdown")` sets it whoever cancels: the stream tripwire, or the host (for example on a broker `onViolation`).
3. The phase stops with `AgentStop("lockdown_violation")`.
4. The binary is marked blocked.
5. A local log line records the event without its payload.

**Amendment 2 (lead decision, review round 2, 2026-09-24): a call to a tool the CLI does not have is not a violation.** Models call application tools by name: the envelope appendix lists them as `## <tool>` headings, the app's own prompts say "call the classify tool", and text in a CAD file can say "call tool X". Such a call runs nothing: the CLI answers it with an error and the model can retry. Before this amendment the tripwire killed the run as `lockdown_violation`, which a valid envelope cannot override (`HARD_FAILURES`) and which marks the binary blocked with no override (step 4). The live Claude S1 smoke failed that way in 1 of 2 runs (Haiku called `classify`), and the real opencode binary does the same for any unknown name. Anyone who can put text in front of the model could have blocked the owner's only paid CLI. The rule now:
- **Claude (`toolListInInit`).** Once the `init` tool list passed the init check, it is authoritative: `--tools ""` and `--strict-mcp-config` leave nothing else Claude can run. A `tool_call` whose name is in neither `allowed` nor that list is a `warning` event ("… which this CLI does not offer; the CLI refuses the call (not a lockdown violation)"). Claude answers it with `<tool_use_error>Error: No such tool available: <name></tool_use_error>` and the turn goes on (recorded live on 2.1.260: `test/cli/fixtures/claude/unoffered-tool-call.jsonl`, 3 turns, envelope delivered). Without an init list the pure check stays fail-closed.
- **Gemini and opencode (no init list).** A call to one of the CLI's **built-in** names (`GEMINI_BUILTIN_TOOLS`, `OPENCODE_BUILTIN_TOOLS`, taken from the 0.49.0 bundle and the 1.17.10 binary) trips at once, as before. A call to any **other** name with no server or our `cad` server is held until its result: when the parser marks the result `unavailable` (Gemini `error.type: "tool_not_registered"`; opencode `Model tried to call unavailable tool '…'`), it is a warning; any other result (a success, or another error) is a violation; a held call still open at the `result` event or the end of the stream is a violation (fail closed). A call to another MCP server trips at once. Verified with both real binaries (`real-gemini.test.ts`, `real-opencode.test.ts`; fixtures `real-0.49.0-unavailable-tool.jsonl`, `real-1.17.10-unavailable-tool.jsonl`).
- **Codex and Cursor** have no refusal marker: every out-of-scope call still trips at once.
- **Never blocked.** A refused unknown name produces no `CliFailure` at all, so it can neither fail the turn nor mark the binary blocked. If the model never recovers, the turn ends like any other turn without an envelope (`bad_output`, not a hard failure).
- **Cost.** For Gemini and opencode, a built-in added by a newer CLI release and not yet on the list is detected only after it ran (it is held, and its non-`unavailable` result trips). The prevention layers above are unchanged; the residual risks say so (§5.9).

### 5.7 Untrusted output (frozen limits)

| Item | Limit or rule |
|---|---|
| stdout line | ≤ 1 MiB. A longer line is dropped and counted. More than 3 dropped lines give `bad_output`. |
| stdout total | ≤ 64 MiB per invocation, else kill + `bad_output` |
| Non-JSON stdout lines | Ignored and counted. More than 100 give `bad_output`. |
| stderr | Ring buffer of 64 KiB. `stderrTail` is ≤ 8 KiB, ANSI-stripped, and scrubbed of the ticket and anything that matches `CLI_ENV_DENY`-style values. |
| Event strings | Data only: never executed, never used as a path, never rendered as HTML (the UI uses text nodes). Model names must match `^[\w.:/@-]{1,128}$` and must **not start with `-`**, or they are dropped. |
| Session ids | Must match `^[A-Za-z0-9_-]{1,128}$` and must **not start with `-`** before they are reused in argv |
| argv values (amended) | `inv.model`, `inv.effort` and `inv.resume.sessionId` are validated in `run()` (the same rules; effort `^[\w.-]{1,32}$`), and the profile schema applies them to `cli.modelArg` and `cli.effortArg`. Where the CLI accepts it, values go as one `--flag=value` argument (`--model=`, `--effort=`, `--resume=`, `--session=`, `--variant=`, `--session-id=`, `--delete-session=`), so no value can be read as a flag. |
| Numbers | Tokens and cost must be finite and ≥ 0. Anything else is dropped with a warning. |
| Envelope | Rules in §3.2.3 |
| Unknown event types | Ignored |

### 5.8 Process control (frozen: `cli/process.ts`)

**Spawn.** `spawn(binary.realPath, args, {cwd: ws.dir, env, stdio: [stdin, "pipe", "pipe"], detached: platform !== "win32", windowsHide: true, shell: false})`.
- `stdin` is `"ignore"` or `"pipe"`. With `"pipe"`, the payload is written and then closed. The exception is Claude's `stream-json` input, which stays open until `closeInput()`.
- **Windows:** an npm `.cmd` shim is resolved to `node <script>` by parsing the shim's target. `shell: true` is never used.

**Timers.**
- Start: 60 s to the first stdout line, never longer than the wall clock (including time added with `extendWall`).
- Stall: `limits.stallMs`. It is paused while a tool call is in flight: one the event stream reports (`tool_call` without its `tool_result`), or one the broker handler reports through the additive `CliRun.brokerBusy(true|false)`. The hook is needed because some CLIs report a call only once it finished (opencode), so a long CAD tool call would otherwise look like a stall. The timer restarts when the last reported call ends.
- Wall: `limits.wallMs` plus any `userWaitMs` the handlers report (`CliRun.extendWall`).

**Kill.** `closeInput()`, wait 2 s, `SIGTERM` to the process group (`-pid`), wait 3 s, then `SIGKILL` to the group. On Windows: `taskkill /PID <pid> /T /F`. The MCP shim is a child of the CLI, so it dies with the group, and it also exits on stdin EOF.

**Lifecycle.**
- The worker keeps a registry of live CLI processes. It kills them all on `exit`, `SIGTERM` and uncaught errors.
- The main process's `WORKER_EXITED` path already kills the worker. The detached groups are killed by the worker's handler. As a backstop, the main process records the process-group ids it hears about and kills them if the worker dies.

**Concurrency.** One CLI process per agent run at a time (phases are sequential), plus probes. Probes are serialized per provider.

### 5.9 Residual risks (shown in Settings → Details)

| CLI | Residual risk | Mitigation or acceptance |
|---|---|---|
| All | The CLI runs as the user with full OS permissions. Lockdown depends on the CLI honoring its own flags. A compromised binary is out of scope. | Real-path display, version gate, tripwires. An optional OS sandbox wrapper (`sandbox-exec`/bwrap) is future hardening. |
| All | Prompts, the design text and tool results go to the vendor under the **user's** plan terms (consumer data handling differs from API zero data retention). | Settings copy (§11.7). The per-provider data-handling note links to the vendor's terms. |
| All | Vendors may restrict automated use of consumer plans, or change flags. | We run only the official binary and never touch credentials. Version gating. |
| Claude | Managed (enterprise) settings still apply and could add hooks. | That is the admin's policy, and it is accepted. |
| Claude | `--max-turns` and `--system-prompt-file` are hidden flags. | The spawn fails closed if they disappear, and the broker enforces turns. |
| Claude | Users who configure Bedrock, Vertex or Foundry through `settings.json` `env` are not supported (`--restricted` ignores it). | Detection says so. |
| Gemini, Codex, opencode | Runtime tripwires **detect** a built-in tool call only after the CLI reported it; they cannot prevent it (the kill races the tool). None of these CLIs reports its tool list before the first model call. | Prevention is the lockdown itself (Gemini `tools.core` + deny-all policy; Codex feature switches + read-only sandbox; opencode deny-all permission). The real-binary harnesses check the model's tool list for Gemini and opencode (§13.1). |
| All | A file planted in a folder above the workspace could add config or instructions (CLIs search upward). | The workspace root has only private ancestors (§5.4); opencode runs with `OPENCODE_DISABLE_PROJECT_CONFIG=1`; Gemini's context file name is per run. |
| Gemini | The user's global `~/.gemini/GEMINI.md` and a `<session_context>` folder listing (including the file names of the user's `includeDirectories`) reach the model. | The workspace is empty. The UI discloses this. |
| Gemini | Hooks and extensions (amended, review round 2): hooks default to on, and extensions add hooks, context files, MCP servers, skills and agents. | `hooksConfig.enabled: false` in the workspace settings and `--extensions=none` on every run and cleanup (verified with the real 0.49.0 binary, control included). System settings (`/etc/gemini-cli`) are the admin's policy and still apply. |
| Gemini, opencode | A call to a name that is neither in scope nor a known built-in waits for the CLI's own "unavailable" answer (§5.6 amendment 2). A built-in added by a newer release and missing from the list is caught only after it ran. | The lockdown prevents built-ins (`tools.core` + deny-all policy; deny-all permission); the lists are refreshed with each verified range. |
| opencode | The user's global instructions reach the model: `~/.config/opencode/AGENTS.md` and the files (or URLs, which opencode fetches) in `instructions` of the global `opencode.json`. opencode has no per-run switch, and a per-run `instructions: []` is concatenated with the user's list, not used instead (verified on 1.17.10). | Disclosed in Settings → Details. `~/.claude/CLAUDE.md` stays out (`OPENCODE_DISABLE_CLAUDE_CODE=1`, verified). Project-level files never load (`OPENCODE_DISABLE_PROJECT_CONFIG=1`). |
| Gemini | A workspace `tools.core: []` wins over a user-level `tools.core` (verified on 0.49.0, §15 G1); later versions may merge differently. | Policy deny-all, plus the tripwire. |
| Gemini | `@path` expansion anywhere in prompts, code fences included (verified, §15 G2). | Every `@` is neutralized in every prompt; `restoreAtPaths()` on the way back. |
| Gemini | Auto model routing and quota fallback switch models silently. | The actual models are recorded, with a warning. |
| Gemini, Codex, opencode | Session cleanup is best effort. If it fails, prompts and design text stay in the CLI's own session files (`~/.gemini/tmp`, `~/.codex/sessions`, opencode's storage) until the CLI's retention removes them. Gemini also keeps, per run and forever, a project entry (the workspace path only) in `~/.gemini/projects.json`, two `~/.gemini/{tmp,history}/aicad-run-<n>/` folders and an empty `projects.json.*.tmp` file: about 0.5 KB per run on 0.49.0, so it grows without bound over thousands of runs (T4, amended review round 2). | Cleanup after every invocation (verified on Gemini 0.49.0 and opencode 1.17.10); Codex only when its `--help` lists `delete`. Shown in Settings → Details. |
| Codex | Never run by us. Whether the MCP shim runs under the read-only Seatbelt profile (the Unix socket connect) is unverified. | Level `static`. Offline tests. §15 X1. |
| Codex | `model_instructions_file` replaces the base instructions, which may lower tool-use quality. | Measured by evals. `developer_instructions` is the alternative. |
| opencode | No OS sandbox. User plugins may run in-process. | Permission deny-all (verified). `--pure` (verified: keeps global plugins out) on runs, probes and cleanup. User MCP servers are disabled per run (verified). |
| opencode | The free Zen models have their own data terms. | UI warning when only Zen is available. |
| Cursor | Server-side web search, unverified tool hiding, global MCP approval. | **Blocked.** |

---

## 6. MCP server (`packages/mcp-server`)

### 6.1 Package

- **Name and license.** `@aicad/mcp-server`, MPL-2.0. The MCP tool **schemas** are published under Apache-2.0 (ADR 0001).
- **Runtime.** ESM, Node ≥ 22. It runs under `node`, or as Electron with `ELECTRON_RUN_AS_NODE=1`.
- **Dependencies.** Runtime: `@aicad/llm-gateway` (types only). There is **no** runtime dependency on `@modelcontextprotocol/sdk`: the shim implements the small server subset it needs, so every CLI run starts fast and has little attack surface. The official SDK (MIT) is a **devDependency**, used for client conformance tests.

```
packages/mcp-server/
  src/stdio.ts            bin "aicad-mcp": the stdio shim (bridge mode now; headless mode later)
  src/jsonrpc.ts          newline-delimited JSON-RPC 2.0, frames ≤ 1 MiB, strict parsing
  src/mcp.ts              initialize, ping, tools/list, tools/call, notifications/initialized, notifications/cancelled
  src/bridge-protocol.ts  FROZEN host ⇄ shim wire types (§6.4)
  src/broker.ts           host side: startBroker(), ToolBroker, createMcpHost() (implements CliMcpHost)
  src/tools.ts            toBrokerTools(defs): names, schemas, annotations
  src/scopes.ts           scope → tool names
  src/headless.ts         (wave ≥ 5) session backend for external clients (ARCHITECTURE §9)
  test/                   SDK-client conformance, bridge fuzz, broker rules, ticket, limits
```

### 6.2 Tools from the registry

`toBrokerTools(defs: readonly ToolDef[])` maps each tool to an MCP tool:

| MCP field | Value |
|---|---|
| `name` | The registry name (snake_case, ≤ 64) |
| `description` | The registry description |
| `inputSchema` | `ToolRegistry.schema(name)`: strict draft 2020-12, the same bytes the API adapters see |
| `annotations` | `{readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false}`. `destructiveHint` is false because every edit lands on the draft branch and is reviewed. Both hints also make Codex's `auto` approval mode pass. |

- **Result:** `{content: [{type: "text", text}], isError}`. There is no `structuredContent`: `ToolData` stays on the host.
- **Tool list:** fixed per scope (`listChanged: false`).

### 6.3 Scopes (frozen)

```ts
export type McpScope = "spec" | "design" | "read" | "submit" | "ext-read" | "ext-edit" | "ext-export";
```

| Scope | Tools | Used by |
|---|---|---|
| `spec` | `set_spec_tests`, `submit_spec` | Runtime SPEC |
| `design` | `DESIGNER_TOOLS` (without `ask_user` when the CLI's call timeout is too short, §3.3) | Runtime BUILD |
| `read` | `READ_ONLY_TOOLS` | Runtime ASK |
| `submit` | `submit_turn` (envelope schema) | Completion mode, `mcp-submit` |
| `ext-read`, `ext-edit`, `ext-export` | ARCHITECTURE §9 scopes, on an `mcp/<client>` branch | External clients (later) |

### 6.4 Bridge protocol (frozen: `bridge-protocol.ts`)

**Transport.** A Unix domain socket at `<socketDir>/b.sock`, in a 0700 directory, or on Windows a named pipe. The shim reads the endpoint from `AICAD_MCP_BRIDGE` and the ticket from `AICAD_MCP_TICKET`.

**Framing.** Newline-delimited JSON, with frames of at most 1 MiB.

```ts
export const BRIDGE_PROTOCOL = 1;

export type BridgeClientMsg =
  | { t: "hello"; v: 1; ticket: string; pid: number; client: { name: string; version: string } | null }  // client = MCP clientInfo
  | { t: "call"; id: number; name: string; args: Record<string, unknown>; toolUseId: string | null }
  | { t: "cancel"; id: number }                     // from notifications/cancelled; advisory
  | { t: "bye" };

export type BridgeHostMsg =
  | { t: "welcome"; v: 1; scope: McpScope; server: { name: "cad"; version: string }; instructions: string; tools: BrokerTool[] }
  | { t: "result"; id: number; text: string; isError: boolean }
  | { t: "closed"; reason: string }                 // broker closing: later calls get the closed text
  | { t: "denied"; reason: "bad_ticket" | "too_many_connections" | "protocol" | "closed" };

export interface BrokerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
```

**Handshake.**
- The shim sends `hello` first. The broker compares the ticket with `timingSafeEqual`.
- The broker allows at most `maxConnections` connections per ticket (default 3, for CLIs that restart the server), with only one active at a time.
- A wrong ticket gets `denied`, and the socket is closed.

### 6.5 Broker (frozen: `broker.ts`)

```ts
export interface BrokerLimits {
  maxCalls: number;            // runtime default 240; submit 4
  maxArgBytes: number;         // 262_144
  maxConnections: number;      // 3
  closeGraceMs: number;        // 5_000
  maxCallsAfterClose: number;  // 2
  handlerTimeoutMs: number;    // 120_000, excluding the handler's reported userWaitMs
}
export interface BrokerOptions {
  dir: string;                                   // workspace.socketDir
  scope: McpScope;
  tools: readonly BrokerTool[];
  instructions: string;
  handler(call: McpToolCall): Promise<McpToolResult>;
  limits?: Partial<BrokerLimits>;
  onClose?(reason: string): void;                // the driver starts closeGraceMs, then kills
  onViolation?(v: { kind: "call_limit" | "arg_size" | "unknown_tool" | "after_close_limit" | "handler_timeout"; detail: string }): void;
}
export interface ToolBroker {
  readonly endpoint: string;                     // socket path or pipe name
  readonly ticket: string;                       // 32 random bytes, hex; never logged
  readonly state: "open" | "closing" | "closed";
  close(reason: string): void;
  dispose(): Promise<void>;                      // closes the listener, unlinks the socket
  stats(): { calls: number; refused: number; connections: number; lastCallAt: number | null };
}
export function startBroker(options: BrokerOptions): Promise<ToolBroker>;
export function createMcpHost(options: { shim: McpShimCommand }): CliMcpHost;     // §7.6
export interface McpShimCommand { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
```

**Rules:**
1. **FIFO, one call at a time.** `DesignSession` is not re-entrant, and some CLIs issue parallel calls.
2. **Before the handler runs:** check the state, the argument size, that the tool is in scope, and `maxCalls`.
   - A violation answers `isError` with a one-line reason and calls `onViolation`.
   - `call_limit` and `after_close_limit` also close the broker.
3. **After `close()`:** every call is answered with `BROKER_CLOSED_TEXT(reason)`. `maxCallsAfterClose` extra calls also trigger `onViolation`, and the driver kills the process.
4. **Handler results** are passed through unchanged, except that the text is clipped at 16 KiB as a backstop (the registry already clips to about 2k tokens). A result with `close` set closes the broker **after** it is delivered.
5. **Logging.** The broker keeps an in-memory log of `{seq, name, argBytes, isError, ms}` for the trace, plus the full text of each result for transcript reconstruction. Arguments and results are never logged to disk.

### 6.6 Shim behaviour (`stdio.ts`)

1. **MCP `initialize`.**
   - Connect to the bridge and send `hello` with the MCP `clientInfo`.
   - Reply with `serverInfo {name: "cad", version}`, `capabilities {tools: {listChanged: false}}` and `instructions` from `welcome`.
   - `protocolVersion`: echo the client's version when it is in our supported list, otherwise answer with our newest.
2. **`tools/list`:** the tools from `welcome`.
3. **`tools/call`:** forward to the broker, then reply with `{content: [{type: "text", text}], isError}`.
4. **Bridge unavailable** (denied, disconnected or closed): every call gets `isError: "The CAD host is unavailable; stop calling tools."`. The shim never hangs.
5. **Unsupported methods** (resources, prompts, sampling, elicitation, logging) answer JSON-RPC `-32601`.
6. **Output channels.** stdout carries JSON-RPC frames only. stderr gets at most 20 short lines per process and never the environment: the CLI's environment includes things such as `CLAUDE_CODE_MESSAGING_TOKEN` (V-here).
7. **Exit** on stdin EOF, or on SIGTERM.

### 6.7 Session binding and branches

- **Host-owned.** The broker never holds a `DesignSession`. The handler closure does: in-app runs use `AgentRun`'s session, which is the agent's draft branch.
- **Nothing reaches the user's document** until they accept the proposal in the existing review UI (ARCHITECTURE §7). This holds for runtime-mode edits exactly as it does for API runs.
- **External clients (later waves).** The desktop app exposes a broker with a per-client `mcp/<client>` branch that goes through the same review UI. Scopes are `ext-read`, `ext-edit` and `ext-export`, with the same broker limits. Headless `aicad-mcp --doc <file.cad.ts>` owns a `DesignSession` in-process and writes proposals to `<file>.proposal.cad.ts`.
- **Every broker instance serves exactly one phase of one run,** which keeps the per-client branch semantics.

### 6.8 Rate limits (summary)

| Limit | Value |
|---|---|
| Calls per phase | 240 in runtime; 4 in `submit` |
| Argument size per call | 256 KiB |
| Concurrency | 1 (FIFO) |
| Connections per ticket | 3, one active at a time |
| Calls after close | 2 |
| Handler time | 120 s, not counting user waits (the question wait is capped at 600 s) |

---

## 7. Gateway: frozen interfaces

### 7.1 `src/types.ts` (additive)

```ts
export type ApiProvider = "anthropic" | "openai" | "google" | "openai-compat";
export type LocalProvider = "ollama";
export type CliProviderId = "claude-cli" | "gemini-cli" | "codex-cli" | "opencode" | "cursor-agent";
export type Provider = ApiProvider | LocalProvider | CliProviderId;

export type ProviderKind = "api" | "cli" | "local";
export const PROVIDER_KINDS: Readonly<Record<Provider, ProviderKind>>;
export function providerKind(p: Provider): ProviderKind;

export type Billing = "metered" | "subscription" | "local";

export interface ToolDef {
  /* existing fields … */
  /** Tool never changes the design. MCP readOnlyHint; adapters never send it to a provider. */
  readOnly?: boolean;
}

export interface ChatResponse {
  /* existing fields … */
  /** From the profile (or the CLI auth probe, e.g. a CLI logged in with an API key is metered). */
  billing: Billing;
  /** Plan usage windows reported by a CLI (Claude rate_limit_event). */
  planUsage?: PlanUsage;
  /** CLI calls only. */
  cli?: CliCallInfo;
}

export interface CliCallInfo {
  provider: CliProviderId;
  version: string;
  sessionId: string | null;
  turns: number | null;             // CLI-internal model round trips
  modelsUsed: string[];             // actual models (may differ from the requested alias)
  envelopeVia: EnvelopeVia | null;
  durationMs: number;
}
export interface PlanUsage {
  provider: CliProviderId;
  status: "allowed" | "allowed_warning" | "rejected" | "unknown";
  windows: PlanWindow[];
  overage: { status: string; inUse: boolean } | null;
  observedAt: string;               // ISO
}
export interface PlanWindow { id: string; utilization: number | null; resetsAt: string | null }   // utilization 0..1
```

`finalizeResponse()` sets `billing` from `ctx.profile.billing`. Every existing adapter gets it for free. Snapshots change once, in wave 1.

### 7.2 `src/errors.ts` (additive)

```ts
export type GatewayErrorCode = /* existing */ | "bad_output" | "quota_exhausted" | "lockdown_violation" | "not_installed" | "not_logged_in";
```

`CliFailureCode` → `GatewayErrorCode`:

| `CliFailureCode` | `GatewayErrorCode` | Retryable |
|---|---|---|
| `not_installed` | `not_installed` | |
| `unsupported` | `config` | |
| `lockdown_violation` | `lockdown_violation` | |
| `not_logged_in` | `not_logged_in` | |
| `rate_limited` | `rate_limited` | yes, with `details.retryAfterMs` |
| `quota_exhausted` | `quota_exhausted` | with `details.resetsAt` |
| `context_overflow` | `context_window_exceeded` | |
| `max_turns` | `bad_output` | |
| `budget` | `budget_exceeded` | |
| `timeout`, `stalled` | `timeout` | |
| `cancelled` | `aborted` | |
| `bad_output` | `bad_output` | |
| `crashed`, `unknown` | `server_error` | |

### 7.3 `src/profile.ts` (additive)

```ts
const provider = z.enum(["anthropic", "openai", "google", "openai-compat", "ollama",
                         "claude-cli", "gemini-cli", "codex-cli", "opencode", "cursor-agent"]);

// new fields on modelProfileSchema
billing: z.enum(["metered", "subscription", "local"]).default("metered"),
cli: z.object({
  agent: z.enum(["claude", "gemini", "codex", "opencode", "cursor"]),
  /** Value for the CLI's model flag (`--model opus`, `-m flash`, `-m provider/model`); null = the CLI's default. */
  modelArg: z.string().min(1).nullable(),
  /** Unified effort → CLI-native value (`--effort`, `model_reasoning_effort`, `--variant`). */
  effortArg: z.partialRecord(effort, z.string()).optional(),
  modes: z.array(z.enum(["completion", "runtime"])).min(1),
  envelopeVia: z.enum(["json-schema", "mcp-submit", "text-json"]),
  /** Set for profiles created by model discovery. */
  discoveredAt: z.string().optional(),
}).optional(),
local: z.object({
  baseURL: z.string(),                 // default http://127.0.0.1:11434
  tag: z.string(),                     // e.g. "qwen3:8b"
  numCtx: z.number().int().positive(),
  keepAlive: z.string().optional(),    // default "10m"
  think: z.boolean().optional(),
}).optional(),

// enum additions
toolSchemaStyle: + "cli-envelope" | "ollama"
capabilities.caching.style: + "cli-managed"
reasoning.style: + "cli-effort-flag" | "ollama-think"
```

**Refinements:**
- A `cli`-kind provider ⇔ `cli` is present, and `billing` ∈ {`subscription`, `metered`}.
- `ollama` ⇔ `local` is present, and `billing = "local"`.
- `pricing` stays required:
  - For CLI profiles it holds the **notional** list price of the matching API model, with `source: "notional: <vendor> API list price; subscription runs are not billed per token"`.
  - Where no API equivalent exists (Gemini on a Google login, Cursor), it is zeros.

### 7.4 Transport operations (additive)

```ts
export type TransportOperation = /* existing */ | "cli.turn" | "ollama.chat";
```

### 7.5 `src/cli/provider.ts` (frozen)

```ts
export type CliAgentId = "claude" | "gemini" | "codex" | "opencode" | "cursor";
export type CliMode = "completion" | "runtime";
export type EnvelopeVia = "json-schema" | "mcp-submit" | "text-json";

export interface CliCapabilities {
  modes: readonly CliMode[];
  envelopeVia: EnvelopeVia;
  promptVia: "stdin" | "argv";
  systemPromptVia: "file-flag" | "env-file" | "config-key" | "agent-config" | "workspace-rules";
  mcpConfigVia: "flag-file" | "workspace-settings" | "config-overrides" | "env-json" | "workspace-file";
  multiTurn: "stdin-stream" | "resume" | "none";
  images: "stream-json" | "file-flag" | "at-path" | "none";
  toolListInInit: boolean;
  reportsTokens: boolean;
  reportsCostUsd: boolean;
  reportsPlanUsage: boolean;
  maxTurnsControl: "flag" | "setting" | "none";
  maxToolCallMs: number;
  sessionCleanup: "none-needed" | "delete-command" | "left-behind";
}

export interface CliHelpInfo { flags: ReadonlySet<string>; subcommands: ReadonlySet<string>; sha256: string }

export interface CliBinary {
  provider: CliProviderId;
  path: string;
  realPath: string;
  source: "settings" | "path" | "known-dir" | "login-shell";
  version: string;                 // normalized
  rawVersion: string;
  help: CliHelpInfo;
  stat: { size: number; mtimeMs: number };
}

export interface CliDetection {
  provider: CliProviderId;
  status: "not_installed" | "unsupported_version" | "blocked" | "ready";
  binary: CliBinary | null;
  lockdown: LockdownReport | null;
  detail: string;
}

export interface CliAuthStatus {
  state: "logged_in" | "logged_out" | "unknown";
  method: string | null;           // label only: "claude.ai", "oauth-personal", "chatgpt", "api-key", …
  plan: string | null;             // e.g. "max"; NEVER email, org, account or user ids
  billing: Billing;
  probe: "command" | "settings-field" | "file-presence" | "none";
  detail: string;
  checkedAt: string;
}

export interface LockdownCheck { id: string; ok: boolean; detail: string }
export interface LockdownReport {
  ok: boolean;
  level: "verified" | "static" | "none";
  checks: LockdownCheck[];
  residualRisks: string[];
}

export interface CliLimits { maxTurns: number; wallMs: number; stallMs: number; maxBudgetUsd?: number }
export interface CliImage { mediaType: ImageMediaType; data: string }        // base64

export interface CliInvocation {
  runId: string;                              // uuid v4 (also the CLI session id where one is accepted)
  mode: CliMode;
  binary: CliBinary;
  workspace: CliWorkspace;
  model: string | null;
  effort: string | null;
  systemPrompt: string;
  prompt: string;
  images: readonly CliImage[];
  structured: { via: EnvelopeVia; schema: Record<string, unknown> } | null;
  mcp: McpAttachment | null;
  resume: { sessionId: string } | null;
  limits: CliLimits;
  env: Readonly<Record<string, string>>;      // cliChildEnv() output
}

export interface CliCommand {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: { kind: "ignore" } | { kind: "text"; text: string } | { kind: "stream-json"; first: string };
  files: ReadonlyArray<{ path: string; content: string; mode: 0o400 | 0o600; encoding?: "utf8" | "base64" }>;   // relative to workspace.dir; (additive, §16) base64 = image bytes
  warnings?: readonly string[];   // (additive, review round 2) emitted by run() as `warning` events before the CLI starts
}

export interface ParseContext { mode: CliMode; allowed: ReadonlySet<string>; serverName: "cad" }

export interface CliUserMessage { text: string; images?: readonly CliImage[] }
export interface CliRunIO { signal?: AbortSignal; onStderrLine?(line: string): void; onStdoutLine?(line: string): void /* (additive, §16) */; now?(): number }

export interface CliRun {
  readonly pid: number | null;
  readonly events: AsyncIterable<CliEvent>;
  send(message: CliUserMessage): void;       // throws unless capabilities.multiTurn === "stdin-stream"
  closeInput(): void;
  readonly done: Promise<CliExit>;
  extendWall?(ms: number): void;             // (additive, §16) add handler wait time to the wall clock
  brokerBusy?(on: boolean): void;            // (additive, §16) a broker call started/ended: pauses the stall timer (§5.8)
}

export interface CliExit {
  code: number | null;
  signal: string | null;
  reason: "exited" | "timeout" | "stalled" | "cancelled" | "killed" | "spawn_failed";
  result: CliResultEvent | null;
  stderrTail: string;
  failure: CliFailure | null;
}

export type CliFailureCode =
  | "not_installed" | "unsupported" | "lockdown_violation" | "not_logged_in"
  | "rate_limited" | "quota_exhausted" | "context_overflow" | "max_turns" | "budget"
  | "timeout" | "stalled" | "cancelled" | "bad_output" | "crashed" | "unknown";
export interface CliFailure { code: CliFailureCode; message: string; retryAfterMs?: number; resetsAt?: string }

export interface DetectOptions {
  overridePath: string | null;               // Settings → CLI path
  env: Readonly<Record<string, string>>;
  extraDirs: readonly string[];              // known install dirs (per provider + common)
  loginShell: boolean;                       // last resort: `$SHELL -ilc 'command -v <name>'`, 5 s, once per session
}

export interface DiscoveredModel {
  modelArg: string; displayName: string; vendor: string; family: string;
  tools: boolean; vision: boolean; contextWindow: number | null; billing: Billing;
}

export interface CliProvider {
  readonly id: CliProviderId;
  readonly agent: CliAgentId;
  readonly label: string;                    // "Claude Code"
  readonly binaryNames: readonly string[];
  readonly minVersion: string;
  readonly verifiedRange: { from: string; to: string } | null;
  readonly capabilities: CliCapabilities;
  readonly loginHint: string;                // shown verbatim: "Run `claude auth login` in a terminal"

  /** Locate the binary, read --version and --help, evaluate lockdown. No model call. */
  detect(options: DetectOptions): Promise<CliDetection>;
  /** `<bin> --version`, normalized. 10 s timeout. */
  version(path: string, env: Readonly<Record<string, string>>): Promise<string>;
  /** Cheap login probe (§4). Never reads credential files or keychain entries. No model call. */
  authStatus(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<CliAuthStatus>;
  /** Pure: can this binary enforce our lockdown? */
  lockdown(binary: CliBinary): LockdownReport;
  /** Bare tool name → the name the model and the event stream use. */
  qualifiedToolName(tool: string): string;
  /** Pure: the exact command, files and stdin for an invocation. */
  buildArgs(inv: CliInvocation): CliCommand;
  /** Pure: CLI-native JSONL lines → normalized events (dialect knowledge lives here only). */
  parseEvents(lines: AsyncIterable<string>, ctx: ParseContext): AsyncIterable<CliEvent>;
  /** Spawn per §5.8 (materialize files, apply tripwires, enforce timers) and stream normalized events. */
  run(inv: CliInvocation, io?: CliRunIO): CliRun;
  /** Graceful → forceful termination of the whole process group. Idempotent. */
  cancel(run: CliRun, reason: "user" | "timeout" | "stalled" | "stop" | "lockdown"): Promise<CliExit>;
  /** Delete the CLI-side session after the phase (Gemini, Codex runtime, opencode). */
  cleanup?(inv: CliInvocation, sessionId: string | null): Promise<void>;
  /** Optional model discovery (Codex `debug models`, opencode `models --verbose`, Cursor `models`). */
  listModels?(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<DiscoveredModel[]>;
}
```

The providers share an abstract `BaseCliProvider`. It implements `run` and `cancel` on top of `spawnCli()` (`process.ts`), the JSONL line reader and `tripwire()`. Each concrete provider implements `buildArgs`, `parseEvents`, `authStatus`, `lockdown` and `qualifiedToolName`.

**Events (frozen, `cli/events.ts`):**

```ts
export type CliEvent =
  | { type: "init"; sessionId: string | null; model: string | null; version: string | null;
      tools: readonly string[] | null; mcpServers: ReadonlyArray<{ name: string; status: string }> | null }
  | { type: "text"; messageId: string | null; text: string; delta: boolean }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; callId: string; qualifiedName: string; server: string | null; tool: string; input: unknown }
  | { type: "tool_result"; callId: string; isError: boolean; text: string; unavailable?: true }   // (additive, §5.6 amendment 2) the CLI refused a name it has no tool for
  | { type: "structured"; value: unknown }
  | { type: "turn"; messageId: string | null; model: string | null; usage: Usage | null; stopReason: StopReason | null }
  | { type: "plan_usage"; usage: PlanUsage }
  | { type: "retry"; attempt: number | null; message: string }
  | { type: "warning"; message: string }
  | { type: "refusal"; message: string }
  | CliResultEvent;

export interface CliResultEvent {
  type: "result";
  ok: boolean;
  subtype: string;               // CLI-native ("success", "error_max_turns", "turn.failed", "exit")
  text: string;                  // final assistant text of the last turn
  sessionId: string | null;
  turns: number | null;
  usage: Usage | null;           // invocation totals
  costUsd: number | null;        // CLI-reported (notional for subscriptions)
  models: readonly string[];
  failure: CliFailure | null;
}
```

A **turn** is one model round trip. The runtime driver builds `RuntimeTurnRecord`s from `turn` events.

### 7.6 `src/cli/mcp.ts` (frozen; implemented by `@aicad/mcp-server`)

```ts
export type McpScope = "spec" | "design" | "read" | "submit" | "ext-read" | "ext-edit" | "ext-export";

export interface McpToolCall { seq: number; name: string; args: Record<string, unknown>; toolUseId: string | null }
export interface McpToolResult {
  text: string;
  isError: boolean;
  /** Close the broker after delivering this result (stop, proposal accepted, spec submitted). */
  close?: string;
  /** Time the handler spent waiting for the user (extends the wall clock). */
  userWaitMs?: number;
}

export interface McpAttachment {
  serverName: "cad";
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;     // non-secret: AICAD_MCP_BRIDGE, ELECTRON_RUN_AS_NODE; never the ticket
  ticketEnv: "AICAD_MCP_TICKET";             // name of the env var the CLI must carry (value in CliMcpSession.ticket)
  toolNames: readonly string[];              // bare names in scope
  callTimeoutMs: number;
}

export interface CliMcpSession {
  readonly attachment: McpAttachment;
  readonly ticket: string;                   // goes only into the CLI's env
  readonly state: "open" | "closing" | "closed";
  close(reason: string): void;
  dispose(): Promise<void>;
  log(): ReadonlyArray<{ seq: number; name: string; isError: boolean; ms: number; text: string }>;
}

export interface CliMcpHost {
  open(request: {
    dir: string;
    scope: McpScope;
    tools: readonly ToolDef[];
    instructions: string;
    handler(call: McpToolCall): Promise<McpToolResult>;
    limits?: Partial<BrokerLimits>;
    onClose?(reason: string): void;
    onViolation?(v: { kind: string; detail: string }): void;
  }): Promise<CliMcpSession>;
}
```

`BrokerLimits` is declared here and re-exported by `@aicad/mcp-server`, which keeps the gateway free of any dependency on the MCP package.

### 7.7 `src/cli/envelope.ts` (frozen)

```ts
export const CLI_TURN_PROTOCOL = 1;
export function envelopeSchema(tools: readonly ToolDef[], style: "plain" | "openai-strict", options?: { maxCalls?: number }): Record<string, unknown>;
export function envelopeAppendix(tools: readonly ToolDef[], via: EnvelopeVia): string;
export function renderTranscript(messages: readonly Message[], fence: string, options: { images: boolean }): { text: string; images: CliImage[]; warnings: string[] };
export function extractEnvelope(raw: unknown, source: "structured" | "submit_turn" | "text"): { ok: true; envelope: TurnEnvelope } | { ok: false; error: string };
export function envelopeToContent(env: TurnEnvelope, tools: readonly ToolDef[], idPrefix: string, turn: number): AssistantContentBlock[];
export function neutralizeAtPaths(text: string): string;   // Gemini only (§4.3): every '@', fences included (amended)
export function restoreAtPaths<T>(value: T): T;            // (additive) undo it in echoed envelopes, text and runtime tool arguments
```

### 7.8 `CliAdapter`, `CliTransport` and payloads (frozen)

```ts
/** TransportCall.payload for operation "cli.turn": JSON-serializable, so Record/Replay transports work unchanged. */
export interface CliTurnPayload {
  protocol: 1;
  provider: CliProviderId;
  model: string | null;
  effort: string | null;
  systemPrompt: string;                         // system blocks + envelopeAppendix
  prompt: string;                               // renderTranscript(...).text
  images: CliImage[];
  structured: { via: EnvelopeVia; schema: Record<string, unknown> } | null;
  toolNames: string[];
  limits: CliLimits;
}

/** What CliTransport.send resolves to (and what a replay fixture's `response` holds). */
export interface CliTurnOutcome {
  provider: CliProviderId;
  version: string;
  events: CliEvent[];                           // normalized; parser tests use raw JSONL fixtures instead
  exit: { code: number | null; signal: string | null; reason: CliExit["reason"] };
  envelope: unknown | null;
  envelopeSource: "structured" | "submit_turn" | "text" | null;
  failure: CliFailure | null;
  durationMs: number;
}

export class CliAdapter implements ProviderAdapter {
  constructor(provider: CliProvider);
  // buildRequest: { operation: "cli.turn", payload: CliTurnPayload, preferStream: false, warnings }
  // parseResponse: CliTurnOutcome → ChatResponse (billing, cli, planUsage; costSource "provider" if result.costUsd, else "profile")
  //   plain text (no tools): finalAssistantText(events), the SAME rule as the transport (amended; events.ts):
  //     the last result's text when non-empty, else the text events after the last tool_call/tool_result
  //   providerModel: the first model used that is in the profile's family, else the first one (Claude lists its
  //     models by output tokens, so side calls on a small model do not win); the family warning fires only when
  //     no model used is in the family
  // parseStream: synthesizes StreamEvents from the outcome
}

export interface CliTransportOptions {
  provider: CliProvider;
  binary(): Promise<CliBinary>;                 // host detection cache; re-stat before spawn
  env(): Readonly<Record<string, string>>;      // host base env for cliChildEnv
  workspaceRoot?: string;
  mcpHost?: CliMcpHost;                         // required for envelopeVia "mcp-submit"
  onPlanUsage?(usage: PlanUsage): void;
}
export class CliTransport implements ProviderTransport {
  constructor(options: CliTransportOptions);
  send(call: TransportCall): Promise<CliTurnOutcome>;
  stream(call: TransportCall): AsyncIterable<CliTurnOutcome>;   // yields exactly one outcome
}

/** Node-only helper for hosts: adapters + transports for the CLI providers. */
export function cliGatewayParts(options: {
  providers?: readonly CliProviderId[];
  binary(provider: CliProviderId): Promise<CliBinary>;
  env(): Readonly<Record<string, string>>;
  mcpHost?: CliMcpHost;
  workspaceRoot?: string;
  onPlanUsage?(usage: PlanUsage): void;
}): { adapters: Partial<Record<CliProviderId, ProviderAdapter>>; transports: Partial<Record<CliProviderId, ProviderTransport>> };

export const CLI_PROVIDERS: ReadonlyMap<CliProviderId, CliProvider>;
```

### 7.9 Gateway wiring changes

- `GatewayOptions.adapters` and `transports` are `Partial<Record<Provider, …>>` (unchanged shape, wider key).
- `#adapters` becomes `Partial<Record<Provider, ProviderAdapter>>`. The built-ins cover the API providers and `ollama`.
  - `#prepare` throws `GatewayError("config", "provider <p> needs an adapter/transport from @aicad/llm-gateway/cli (Node only)")` for a CLI provider that was not injected.
- `#transportFor`:
  - `ollama` gets `new OllamaTransport({baseURL})`.
  - A CLI provider with nothing injected throws the same config error.
- **Budget (additive):**

```ts
class BudgetGuard {
  /** Record an already-incurred cost without a reservation (CLI runtime phases). Never throws. */
  charge(entry: { model: string; responseId: string; costUsd: number }): void;
}
class Task {
  chargeExternal(entry: { model: string; responseId: string; costUsd: number; billing: Billing }): void;
}
interface LedgerEntry { /* existing */ billing?: Billing; source?: "call" | "external" }
```

- **`smallModelFor(provider: Provider): ModelRef | null`** replaces both copies of `SMALL_MODEL_BY_PROVIDER` (§9.3).
- **Package export:** `"./cli": {"types": "./dist/cli/index.d.ts", "import": "./dist/cli/index.js"}`. The root entry never imports `node:*`, apart from the existing dynamic `node:fs/promises` in `loadGatewayConfigFile`.

---

## 8. Agent: frozen interfaces

### 8.1 `AgentOptions` (additive)

```ts
export interface AgentOptions {
  /* existing … */
  /** Runs SPEC/BUILD/ASK inside a CLI agent (Node hosts inject CliAgentRuntime). Absent → completion mode for CLI profiles. */
  runtime?: AgentRuntime;
  /** Default "auto" (§3.4). */
  cliMode?: "auto" | "completion" | "runtime";
  /** Per-phase overrides of CLI_PHASE_LIMITS. */
  cliLimits?: Partial<Record<"completion" | RuntimePhase, Partial<CliLimits>>>;
}

export const CLI_PHASE_LIMITS: Readonly<Record<"completion" | RuntimePhase, CliLimits>> = {
  completion: { maxTurns: 3,  wallMs: 180_000,   stallMs: 120_000 },   // designer turn in completion mode: wallMs 300_000
  SPEC:       { maxTurns: 10, wallMs: 300_000,   stallMs: 180_000 },
  BUILD:      { maxTurns: 42, wallMs: 1_200_000, stallMs: 180_000 },   // AgentLimits.maxTurns + 2
  ASK:        { maxTurns: 10, wallMs: 180_000,   stallMs: 120_000 },
};
export const CLI_QUESTION_WAIT_MS = 600_000;
```

### 8.2 `src/runtime.ts` (frozen)

```ts
export type RuntimePhase = "SPEC" | "BUILD" | "ASK";

export interface RuntimeToolCall { seq: number; name: string; input: Record<string, unknown>; toolUseId: string | null }
export type RuntimeToolResult = McpToolResult;          // { text, isError, close?, userWaitMs? }
export type TurnEndDecision = { action: "continue"; message: string } | { action: "finish" };

export interface RuntimeTurnRecord {
  model: string;
  usage: Usage | null;
  costUsd: number;                                       // estimate from profile pricing (notional)
  toolCalls: string[];
  stopReason: StopReason | null;
  latencyMs: number;
}

export interface RuntimePhaseSpec {
  phase: RuntimePhase;
  role: AgentRole;                                       // "designer" | "spec_writer"
  profile: ModelProfile;                                 // CLI profile with "runtime" in cli.modes
  choice: ModelChoice;
  system: string;                                        // system blocks joined; the driver appends RUNTIME_APPENDIX_V1
  prompt: string;                                        // first user message
  scope: "spec" | "design" | "read";
  tools: readonly ToolDef[];                             // registry.defs() for the scope (readOnly set)
  limits: CliLimits;
  signal?: AbortSignal;
  handleToolCall(call: RuntimeToolCall): Promise<RuntimeToolResult>;
  onTurnEnd(info: { finalText: string; turns: number }): Promise<TurnEndDecision> | TurnEndDecision;
  onModelTurn(record: RuntimeTurnRecord): void;
  onPlanUsage?(usage: PlanUsage): void;
}

export interface RuntimePhaseOutcome {
  endedBy: "closed" | "cli_end" | "max_turns" | "timeout" | "stalled" | "cancelled" | "cli_error" | "lockdown_violation" | "refusal";
  closeReason: string | null;
  finalText: string;
  turns: number;
  toolCalls: number;
  usage: Usage;
  costUsd: number;                                       // settled: CLI-reported when available, else the sum of estimates
  costSource: "provider" | "profile" | "none";
  billing: Billing;
  sessionId: string | null;
  modelsUsed: string[];
  planUsage: PlanUsage | null;
  failure: CliFailure | null;
  transcript: Message[];                                 // rebuilt; tool results from the broker log
  cli: { provider: CliProviderId; version: string; lockdown: LockdownReport["level"] };
}

export interface AgentRuntime {
  readonly kind: "cli";
  supports(profile: ModelProfile, phase: RuntimePhase): boolean;
  runPhase(spec: RuntimePhaseSpec): Promise<RuntimePhaseOutcome>;
}

export const RUNTIME_APPENDIX_V1: string;               // §3.3; one constant, versioned
```

### 8.3 `src/cli-runtime.ts` (frozen; subpath `@aicad/agent/cli-runtime`, Node only)

```ts
export interface CliAgentRuntimeOptions {
  providers?: ReadonlyMap<CliProviderId, CliProvider>;   // default CLI_PROVIDERS
  binary(provider: CliProviderId): Promise<CliBinary>;
  env(): Readonly<Record<string, string>>;
  mcpHost: CliMcpHost;                                    // createMcpHost({ shim }) from @aicad/mcp-server
  workspaceRoot?: string;
  keepWorkspaces?: boolean;                               // debugging only
  clock?: () => number;
}
export class CliAgentRuntime implements AgentRuntime {
  constructor(options: CliAgentRuntimeOptions);
}
```

**`runPhase` algorithm (normative):**
1. Resolve the provider from `profile.provider`. Get the binary. Check that `lockdown(binary).ok` holds, otherwise fail with `unsupported`.
2. `createCliWorkspace()`.
3. `mcpHost.open({scope, tools, handler: spec.handleToolCall, onClose, onViolation})`.
4. Build the `CliInvocation` (runtime mode):
   - the system prompt is `spec.system` plus the appendix;
   - `env` is `cliChildEnv(host env, {extra: {AICAD_MCP_TICKET: session.ticket, …provider extras}})`.
5. Call `provider.run(inv, {signal})`. For each event:
   - **tripwire** → on a violation: cancel, `endedBy: "lockdown_violation"`;
   - **`turn`** → `onModelTurn`. The turn count reaching `limits.maxTurns` closes the broker with "max_turns" and ends the phase with `max_turns`;
   - **`plan_usage`** → `onPlanUsage`;
   - **`refusal`** → cancel, `endedBy: "refusal"`;
   - **`result`** → if the broker is closed, finish. Otherwise call `onTurnEnd`, then:
     - `continue`: through `run.send()` (`stdin-stream`), or through a new `run()` with `resume` (`resume`);
     - `finish`: `closeInput()`, then wait for the exit (grace 5 s), then `cancel`.
6. When `mcp.onClose` fires, arm `closeGraceMs`. Once it expires, or once the calls after close pass the limit, `cancel(run, "stop")`.
7. `finally`: `provider.cleanup?.()`, `session.dispose()`, `workspace.dispose()`. Every error path still yields a `RuntimePhaseOutcome`: `runPhase` throws only for programmer errors.

### 8.4 `AgentRun` integration (normative)

- **`#modeFor(role, phase)`** implements §3.4.
- **`#build(kind)`** dispatches to `#buildRuntime(kind)` when the mode is runtime. Otherwise it runs the existing loop, whose `callModel` is served in completion mode by the CLI adapter.
- **`#buildRuntime(kind)`:**

  ```
  spec = {
    phase: "BUILD", role: "designer", profile, choice: #models.designer,
    system: #system texts joined, prompt: #buildHeader(kind),
    scope: "design", tools: registry.defs() (minus ask_user per §3.3), limits: CLI_PHASE_LIMITS.BUILD ⊕ options,
    handleToolCall: (c) => #runtimeCall(c),        // §3.3 pseudo-code; ToolUseBlock{id: c.toolUseId ?? `rt_${c.seq}`}
    onTurnEnd: (i) => #runtimeTurnEnd(i),           // nudges → implicit proposal → finish; sets #stop via #pendingStop
    onModelTurn: (r) => { #unsettledUsd += r.costUsd; trace.llm({... mode: "cli-runtime"}); turns++ },
    onPlanUsage: hooks.onPlanUsage,
  }
  outcome = await runtime.runPhase(spec)
  task.chargeExternal({ model, responseId: outcome.sessionId ?? runId, costUsd: outcome.costUsd, billing }); #unsettledUsd = 0
  conversations.designer = outcome.transcript
  ```

  **Mapping `endedBy` to stops:**

  | `endedBy` | Result |
  |---|---|
  | `closed` | The broker was closed by our own stop or acceptance, so the state is already set. |
  | `cli_end` without a stop | `no_progress`, through the nudge logic |
  | `max_turns` | `max_turns` |
  | `timeout`, `stalled`, `cli_error` | `model_error`, with the `CliFailure` code in the message |
  | `lockdown_violation` | `lockdown_violation` |
  | `refusal` | `refusal` |
  | `cancelled` | `cancelled` |

- **`#spec()`** calls `runSpecWriterRuntime(rc, runtime, prompt, session, input)` (new in `spec-writer.ts`). It shares `specHeader()` and closes on a successful `submit_spec`.
- **`#ask()`** in runtime mode: scope `read`. `onTurnEnd` returns `finish`, and `finalText` becomes `#answer`.
- **`#budgetGate()`** compares `budget.spentUsd + #unsettledUsd` against the 80 % threshold.
- **`callModel`** is unchanged. Completion-mode CLI calls go through the gateway, where projection and reservation use the profile's notional pricing.

### 8.5 Trace, stop reasons, results (additive)

```ts
export type AgentStopReason = /* existing */ | "lockdown_violation";
export interface LlmCallRecord { /* existing */ mode?: "gateway" | "cli-completion" | "cli-runtime"; billing?: Billing }
export interface AgentResult { /* existing */ billing: Billing; planUsage?: PlanUsage }   // billing of the designer's profile
export interface AgentHooks { /* existing */ onPlanUsage?(usage: PlanUsage): void }
```

`LLMSolver` (unchanged API) records `mode` and `billing` in `AgentRunRecord`. Its default name is `agent:<designer profile id>`, for example `agent:claude-cli:opus`.

---

## 9. Model and provider registry

### 9.1 Built-in CLI profiles (static aliases; each CLI resolves them)

| Profile id | `cli.modelArg` | Family / vendor | Pricing (notional) | Modes | Envelope | Efforts (`effortArg`) |
|---|---|---|---|---|---|---|
| `claude-cli:opus` | `opus` | `claude-opus` / anthropic | = `claude-opus-5-5` list price | completion, runtime | json-schema | low…max → `--effort` same names |
| `claude-cli:sonnet` | `sonnet` | `claude-sonnet` / anthropic | = `claude-sonnet-5` | completion, runtime | json-schema | low…max |
| `claude-cli:haiku` | `haiku` (V-here: runs as `claude-haiku-4-5-20251001`) | `claude-haiku` / anthropic | = `claude-haiku-4-5` | completion, runtime | json-schema | none |
| `claude-cli:fable` | `fable` | `claude-fable` / anthropic | = `claude-fable-5-1` | completion, runtime | json-schema | low…max |
| `gemini-cli:pro` | `pro` | `gemini-pro` / google | zeros (request quotas) | completion, runtime | mcp-submit | none (no CLI flag) |
| `gemini-cli:flash` | `flash` | `gemini-flash` / google | zeros | completion, runtime | mcp-submit | none |
| `gemini-cli:flash-lite` | `flash-lite` | `gemini-flash` / google | zeros | completion | mcp-submit | none |
| `gemini-cli:auto` | `auto` | `gemini-auto` / google | zeros | completion, runtime | mcp-submit | none |
| `codex-cli:default` | `null` (the account default) | `gpt-6` / openai | zeros (unknown model) | completion, runtime | json-schema | low…xhigh → `model_reasoning_effort` |
| `codex-cli:gpt-6-sol` | `gpt-6-sol` | `gpt-6` / openai | = `gpt-6-sol` list price | completion, runtime | json-schema | same |
| `codex-cli:gpt-6-luna` | `gpt-6-luna` | `gpt-6` / openai | = `gpt-6-luna` | completion | json-schema | same |
| `cursor-agent:auto` | `null` | `cursor-auto` / cursor | zeros | — (blocked) | text-json | none |

**Common fields.**
- `billing` is `subscription` by default. The auth probe can override it to `metered` (§4).
- `displayName` is "<Model> (<CLI>, your plan)".
- `promptVariant` is the family's variant: `claude`, `gemini` or `openai`.
- `toolSchemaStyle` is `cli-envelope`, and `caching.style` is `cli-managed`.
- `capabilities.tools` is `true`, and `strictTools` is `false` (we validate).
- `vision` depends on the channel.

**Context windows and limits** are copied from the matching API profile where one exists. Otherwise they are conservative: a 128k window and 16k output.

**opencode** has **no static profiles**. Its models are all discovered (§9.2).

### 9.2 Dynamic discovery

`profileFromDiscovery(provider, m: DiscoveredModel, base?: ModelProfile): ModelProfile` builds profiles with the id `<provider>:<modelArg>`. Sources:
- **Codex:** `codex debug models`.
- **opencode:** `opencode models --verbose`.
  - It lists only models with `capabilities.toolcall`.
  - `billing` is `metered` when the models.dev cost is above 0, otherwise `subscription`.
  - Anthropic-provider models are hidden when opencode's only credential for them is a Claude plan.
- **Cursor:** `cursor-agent models`.
- **Ollama:** §10.

Discovery runs in the desktop main process when Settings opens and on **Re-check**, cached for 10 minutes. Discovered profiles go to the worker in `WorkerRunConfig.profiles`, which already carries the registry.

### 9.3 Routing and small models

- **Routing is unchanged.** Roles map to profile ids, and the judge-family rule uses `family`, so for example `claude-cli:opus` vs `claude-cli:fable` passes.
- **`smallModelFor(provider)`** is one table in the gateway, replacing the copies in `agent/models.ts` and `desktop/settings.ts`:

  | Provider | Small model |
  |---|---|
  | `anthropic` | `claude-haiku-4-5` |
  | `openai` | `gpt-6-luna` |
  | `google` | `gemini-3.5-flash-lite` |
  | `claude-cli` | `claude-cli:haiku` |
  | `gemini-cli` | `gemini-cli:flash-lite` |
  | `codex-cli` | `codex-cli:gpt-6-luna` |
  | `opencode`, `cursor-agent`, `ollama` | `null` (use the designer) |

  - **Local profiles by kind (amended, §10).** Built-in `ollama:<tag>` profiles have provider `openai-compat` plus a `local` block, so hosts must decide "local" with `profileKind(profile)` (`local` for a `local` block, provider `ollama` or `billing: "local"`), never with `provider === "ollama"`. `smallModelForProfile(profile)` returns `null` for them. The auto-default step 8 (`ollama`) and the `LOCAL_UNAVAILABLE` precheck (§11.3) use `profileKind`.

- **Auto defaults** (desktop, only when the user has **not** chosen models): the first *ready* provider in this order:
  1. `claude-cli`
  2. `codex-cli`
  3. `gemini-cli`
  4. `opencode`
  5. `anthropic` (key)
  6. `openai` (key)
  7. `google` (key)
  8. `ollama`

  Its role table:

  | Provider | designer | spec_writer | triage | judge |
  |---|---|---|---|---|
  | `claude-cli` | `claude-cli:opus` (medium) | `claude-cli:opus` (high) | `claude-cli:haiku` | `claude-cli:fable` |
  | `gemini-cli` | `gemini-cli:pro` | `gemini-cli:pro` | `gemini-cli:flash-lite` | — |
  | `codex-cli` | `codex-cli:gpt-6-sol` | `codex-cli:gpt-6-sol` | `codex-cli:gpt-6-luna` | — |

  - For the providers with no judge listed, the judge is taken from another ready provider's family if one exists. Otherwise the router warns, as today.
  - Settings shows "Using Claude Code (detected)" with a **Change** link.

---

## 10. Local models (Ollama)

**Amended (wave 3, recorded in §16).** The native adapter below was not built. Built-in and discovered local profiles are `provider: "openai-compat"` with a `local` block and `billing: "local"`, and reach Ollama through `/v1` (`ollamaProfile()`). That brings back the risk this section rejected, so it is handled explicitly:
- **`ollamaContextCheck(profile)`** (`@aicad/llm-gateway/cli`) reads `/api/ps` and compares the context the server loaded the model with against `local.numCtx`. Below it, the result carries a warning that names the fix (`OLLAMA_CONTEXT_LENGTH=<numCtx>`). A model that is not loaded yet gives `ok: null`. Hosts run it before a local run and again after the first call, and show the warning.
- **The profile quirk** says the same in Settings.
- **Routing** uses `profileKind()` (§9.3), because the provider is `openai-compat`.
- The native `/api/chat` adapter below stays the target design. With it `num_ctx` is set per request and the check is no longer needed.

**Why not `openai-compat`? (original reasoning)**
- Ollama's `/v1` endpoint cannot set `num_ctx`. The context defaults to 4k on GPUs with less than 24 GiB [DOCS], and that would silently truncate our roughly 10k-token prefix (system prompt, reference and tools).
- Capabilities are only exposed natively (`/api/show`).
- `openai-compat` stays available for vLLM, LM Studio and OpenRouter, and for Ollama when the user sets `OLLAMA_CONTEXT_LENGTH` themselves.

**Frozen:**

```ts
// src/adapters/ollama.ts: pure mapping to POST /api/chat
export class OllamaAdapter implements ProviderAdapter {}
// payload: { model: local.tag, messages, tools, stream: true, options: { num_ctx: local.numCtx }, keep_alive: local.keepAlive ?? "10m",
//            think?: boolean }   images → message.images (base64 only); tool results → role "tool" messages
// usage: final chunk prompt_eval_count → inputTokens, eval_count → outputTokens; cost 0; billing "local"

// src/transport/ollama.ts: fetch, runtime-agnostic
export class OllamaTransport implements ProviderTransport {
  constructor(options: { baseURL: string; timeoutMs?: number });
  send(call: TransportCall): Promise<unknown>;          // stream:false
  stream(call: TransportCall): AsyncIterable<unknown>;  // NDJSON chunks
}

// src/local/ollama-discovery.ts
export interface OllamaStatus { running: boolean; version: string | null; models: OllamaModelInfo[]; detail: string }
export interface OllamaModelInfo { tag: string; family: string | null; parameterSize: string | null; tools: boolean; vision: boolean; thinking: boolean; contextLength: number | null }
export function probeOllama(baseURL: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<OllamaStatus>;  // /api/version, /api/tags, /api/show per model
export function ollamaProfile(m: OllamaModelInfo, baseURL: string): ModelProfile;   // id "ollama:<tag>", numCtx = min(32768, contextLength ?? 8192)
```

**Rules:**
- The base URL defaults to `http://127.0.0.1:11434`. A non-loopback URL must be set explicitly in Settings, and credentials in the URL are refused, as `baseUrlProblem` already does.
- Only models whose `/api/show` capabilities include **`tools`** are offered for agent roles. `vision` gates the judge.
- There is no `tool_choice`; we never force it anyway.
- **Errors:**

  | Response | `GatewayErrorCode` |
  |---|---|
  | 404 "model … not found" | `not_found` |
  | 400 "does not support tools" | `unsupported_input` |
  | Connection refused | `connection`. The start precheck returns `LOCAL_UNAVAILABLE`. |

- **The app never pulls models.** Settings shows the `ollama pull <tag>` command, because disk space is the user's call.

---

## 11. Desktop and app UX

### 11.1 Process placement

```
main process                               agent utility process (worker)                     children
────────────                               ──────────────────────────────                     ────────
CliDetector (detect, version, --help,  ─►  WorkerRunConfig.cli { binaries, mode, mcpShim,      CLI process group (cwd = workspace)
  auth probes; cache by realPath/stat)       workspaceRoot }, profiles (+discovered)             └─ aicad-mcp shim (spawned by the CLI)
Ollama probe                               LLMGateway (+cliGatewayParts, OllamaTransport)             └─ unix socket ──► ToolBroker
Settings store (+cliPaths, cliMode,        CliAgentRuntime + createMcpHost({shim})                                     (in the worker)
  ollamaBaseUrl)                           Agent (AgentRun owns DesignSession = draft branch)
AgentHost.start precheck (§11.3)           live-process registry → kill all on exit
```

**Shim command:**
- In packaged builds: `{command: <app executable, app.getPath("exe")>, args: [<resources>/app.asar.unpacked/node_modules/@aicad/mcp-server/dist/stdio.js], env: {ELECTRON_RUN_AS_NODE: "1"}}`.
- In development, the same, with the Electron binary and the workspace path.
- Headless Node (the CLI and evals) uses `{command: process.execPath, args: [require.resolve("@aicad/mcp-server/stdio")]}`.

**Worker checks.** The worker re-stats each `CliBinaryRef` before spawning. On a mismatch it re-runs `--version` and `--help` and applies §5.5, so the check fails closed.

### 11.2 Detection and probes (main process)

```ts
// packages/desktop/src/agent/cli-detect.ts
export interface CliBinaryRef { provider: CliProviderId; path: string; realPath: string; version: string; size: number; mtimeMs: number; helpSha256: string }
export class CliDetector {
  constructor(deps: { providers: ReadonlyMap<CliProviderId, CliProvider>; env: () => Record<string, string>; settings: () => StoredSettings; now?: () => number });
  status(options?: { force?: boolean; providers?: readonly CliProviderId[] }): Promise<CliProviderStatus[]>;   // detection 10 min, auth 60 s
  binaryRef(provider: CliProviderId): CliBinaryRef | null;
  markBlocked(provider: CliProviderId, realPath: string, reason: string): void;                               // after a tripwire
  lastPlanUsage(provider: CliProviderId): PlanUsage | null;
}
```

- **Known install directories:** `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`, the newest `~/.nvm/versions/node/*/bin`, `%APPDATA%\npm`, plus per-provider directories (for example `~/.claude/local`).
- **Login shell.** A packaged macOS app's `PATH` lacks most of these. The login-shell lookup runs at most once per app session, with a 5 s timeout.
- **Parallelism.** Probes run in parallel across providers and are serialized within one provider. Each has a 10 s timeout. None calls a model.

### 11.3 Start precheck (`AgentHost.start`)

For every provider used by the run's effective models:

| Kind | Check | Error code |
|---|---|---|
| `api` | Key resolved, as today (`keyRequired`) | `NO_API_KEY` |
| `cli` | `detection.status`: `not_installed` → | `CLI_NOT_INSTALLED` |
| | `unsupported_version` → | `CLI_UNSUPPORTED` |
| | `blocked` → | `CLI_BLOCKED` |
| | auth `logged_out` → (`unknown` passes) | `CLI_NOT_LOGGED_IN` |
| `local` (by `profileKind`, §9.3) | Ollama running, and the tag is present with `tools`; `ollamaContextCheck` warns (does not refuse) when the loaded context is below `local.numCtx` | `LOCAL_UNAVAILABLE` |

- The message names the provider, the roles affected and the fix: the login hint, the minimum version, or `ollama pull`.
- `agent-service` maps every one of these codes to the **Open Settings** action, with the provider row highlighted.
- CLI runs need no secrets: `secrets` stays empty for them.

### 11.4 IPC protocol additions (frozen; `packages/app/src/agent-protocol.ts`)

The version stays `v: 1`. The renderer and the main process ship together, and main keeps rejecting unknown values. Every change is additive.

```ts
export type ApiProviderId = "anthropic" | "openai" | "google" | "openai-compat";
export type CliProviderId = "claude-cli" | "gemini-cli" | "codex-cli" | "opencode" | "cursor-agent";
export type LocalProviderId = "ollama";
export type ProviderId = ApiProviderId | CliProviderId | LocalProviderId;
export type ProviderKindId = "api" | "cli" | "local";
export type BillingKind = "metered" | "subscription" | "local";
export type CliModeSetting = "auto" | "completion" | "runtime";

export type AgentStartErrorCode =
  | "NO_API_KEY" | "BUSY" | "INVALID_REQUEST" | "UNAVAILABLE"
  | "CLI_NOT_INSTALLED" | "CLI_UNSUPPORTED" | "CLI_BLOCKED" | "CLI_NOT_LOGGED_IN" | "LOCAL_UNAVAILABLE";

export interface ProviderKeyStatus { id: ApiProviderId; /* rest unchanged */ }
export interface SetApiKeyRequest { v: AgentProtocolVersion; provider: ApiProviderId; key: string }
export interface ClearApiKeyRequest { v: AgentProtocolVersion; provider: ApiProviderId }

export interface ModelProfileInfo { id: string; name: string; provider: ProviderId; family: string; kind: ProviderKindId; billing: BillingKind; available: boolean }
export interface AgentModelInfo { /* existing */ provider: ProviderId; kind: ProviderKindId; billing: BillingKind }

export interface PlanUsageView {
  status: "allowed" | "allowed_warning" | "rejected" | "unknown";
  windows: Array<{ id: string; label: string; utilization: number | null; resetsAt: string | null }>;   // label: "5-hour", "7-day"
  observedAt: string;
}

export interface CliProviderStatus {
  id: CliProviderId;
  label: string;                                  // "Claude Code"
  installed: boolean;
  path: string | null;
  pathSource: "settings" | "path" | "known-dir" | "login-shell" | null;
  version: string | null;
  support: "ready" | "unsupported_version" | "blocked" | "not_installed";
  supportDetail: string;                          // e.g. "needs ≥ 2.1.260", "web search cannot be disabled"
  lockdownLevel: "verified" | "static" | "none" | null;
  residualRisks: string[];
  auth: "logged_in" | "logged_out" | "unknown";
  plan: string | null;                            // e.g. "max"; never email/org
  billing: BillingKind;
  loginHint: string;
  modes: Array<"completion" | "runtime">;
  planUsage: PlanUsageView | null;
  checkedAt: string | null;
}

export interface LocalProviderStatus {
  id: "ollama";
  baseUrl: string;
  running: boolean;
  version: string | null;
  models: Array<{ id: string; tag: string; tools: boolean; vision: boolean; contextLength: number | null }>;
  detail: string;
}

export interface AgentSettingsView {
  /* existing … */
  cli: CliProviderStatus[];
  local: LocalProviderStatus[];
  cliMode: CliModeSetting;
}
export interface SettingsUpdate {
  /* existing … */
  cliPaths?: Partial<Record<CliProviderId, string | null>>;   // validated: absolute, exists, executable, basename ∈ binaryNames
  cliMode?: CliModeSetting;
  ollamaBaseUrl?: string | null;
}
export interface ProbeProvidersRequest { v: AgentProtocolVersion; providers?: ProviderId[] }
export interface SettingsBridge {
  /* existing … */
  probeProviders(request: ProbeProvidersRequest): Promise<AgentSettingsView>;   // channel "settings:probeProviders"
}

// AgentEventBody additions
//   | { type: "plan"; provider: CliProviderId; usage: PlanUsageView }
//   llm:  + billing?: BillingKind
//   cost: + notional?: boolean      (true when any spend in the run is subscription/notional)
// AgentRunResult: + billing?: BillingKind
```

**Commands** (additive, in `commands/commands.ts`):

| Command | Does |
|---|---|
| `settings.probeProviders` | Re-runs detection |
| `settings.setCliPath { provider, path \| null }` | Sets or clears a path override |
| `settings.setCliMode { mode }` | Sets the CLI mode |
| `settings.setOllamaUrl { url \| null }` | Sets the Ollama URL |

The MCP `CommandSource` stays reserved for the external server.

### 11.5 Settings layout

The **Models & providers** section has three groups:

1. **CLI agents (your subscription).** One row per CLI:
   - label, status badge and version;
   - the path, with **Change…**;
   - login state and plan, for example "Logged in · Max plan";
   - plan usage bars (Claude: 5-hour and 7-day);
   - **Re-check**, and **How to log in**, which copies the login hint;
   - a **Details** disclosure with the lockdown level, the checks and the residual risks.

   The badges:

   | Badge | Meaning |
   |---|---|
   | **Ready** | Supported, lockdown passes, logged in |
   | **Log in needed** | Installed but logged out |
   | **Update needed** | Version below the minimum |
   | **Not supported yet** | Blocked, with the reason |
   | **Not installed** | Not found, with an install link to the vendor's docs |

2. **Local models (Ollama).** Running state, base URL, and the models that have tools/vision capability. For a missing model it shows the `ollama pull` command.
3. **API keys (optional).** The existing key rows.

**Model pickers** list every profile, grouped by provider. Each carries a kind badge (Plan, Local, API key), and unavailable profiles are disabled with the reason.

Advanced settings: **Agent mode for CLI providers:** Automatic (recommended), Single calls only, Agent runtime.

### 11.6 Budget display

- The budget stays one number per task: "Budget per task: $1.00".
- For runs on subscription profiles:
  - the cost meter shows "≈ $0.42 plan usage (API list price; not billed)";
  - the 80 % checkpoint reads "About 80 % of this task's plan-usage budget is spent…".

### 11.7 Copy (frozen wording, ASCII quotes)

- **CLI group intro:** "Use AI coding tools you already have. Runs go through your own account and count against that tool's plan limits; the app never sees your login. The tool runs with its own tools switched off and can only use this app's CAD tools, in an empty temporary folder."
- **Data note:** "Prompts and your design are sent to the tool's vendor under your plan's terms."
- **Not-logged-in:** "<Label> is installed but not logged in. Run `<login command>` in a terminal, then press Re-check."
- **Blocked (Cursor):** "Not supported yet: Cursor Agent has no documented way to switch off its web search in headless runs, so the app cannot guarantee it only uses CAD tools."

---

## 12. Usage and budget accounting

| Billing | Pre-call projection (completion) | Charged to the task | Shown as |
|---|---|---|---|
| `metered` (API keys; a CLI logged in with an API key) | Profile pricing, as today | Actual cost (provider-reported or profile) | "$0.42" |
| `subscription` (CLI plans) | Profile pricing = **notional** list price (0 when unknown) | Notional: CLI-reported `total_cost_usd` (Claude, `costBasis: "list"`), else profile pricing × usage, else 0 | "≈ $0.42 plan usage" |
| `local` | 0 | 0 | "local" |

**Rules:**
- The same `BudgetGuard` and the same 80 % checkpoint apply to every billing kind, so one per-task budget caps plan consumption too. Mixed runs share the cap.
- **Always-on limits** do not depend on dollars: `CLI_PHASE_LIMITS` (turns, wall and stall) and the broker's call limit. For providers with zero notional pricing (Gemini on a Google login, Cursor), these are the effective caps.
- **Runtime phases:**
  - Each `turn` adds an estimate (profile pricing × turn usage) to `#unsettledUsd`.
  - At the end of the phase, `Task.chargeExternal()` settles `outcome.costUsd` and resets the estimate.
  - Worst-case overshoot is one model turn beyond the gate.
  - Claude also gets `--max-budget-usd` as a CLI-side backstop.
- **Plan usage.** Claude `rate_limit_event`s go to `onPlanUsage`, then the `plan` event, then the detector cache.
  - A cached `status: "rejected"` only produces a warning before a run, because it may be stale. It is never a start error.
  - A live `rejected` during a run ends the run with `quota_exhausted` and the reset time.
  - The UI shows utilization and reset times.
- **Tokens in the trace** come from the CLI's usage reports:
  - Claude: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` and `output_tokens`, with thinking tokens in `reasoningTokens`.
  - Codex: cumulative per thread, so the deltas are computed.
  - opencode: summed `step_finish`.
  - Gemini: `stats`.
  - Cursor: `result.usage` on newer builds.

---

## 13. Evals and tests

### 13.1 Offline tests (default, run in CI)

| Area | Tests |
|---|---|
| Parsers | `test/fixtures/cli/<agent>/*.jsonl` of raw CLI output → expected `CliEvent[]`. Sources: Claude from recorded smoke runs (scrubbed: session ids, uuids); Gemini from `--fake-responses` runs; Codex, opencode and Cursor from doc and source examples and the research captures. Includes every failure signature in §4. |
| `buildArgs` | Snapshot per provider × mode × channel. Asserts: no ticket and no prompt in argv (except Cursor's prompt); the lockdown flags are present; the files are written with mode 0400. |
| Lockdown | `--help` text fixtures per version → `LockdownReport`. Cursor 2026.01.28 must be `none`. |
| Env | Allowlist, deny pattern, forced values, `PATH` order, stripped `CLAUDE_CODE_*`, `ELECTRON_RUN_AS_NODE`, `CI`. |
| Envelope | Schema strictness (both styles, validated against the OpenAI strict rules), extraction from each source, the size and count caps, unknown tools, the repair path, transcript fence injection (content containing `</user-…>` without the fence cannot close a block). |
| Broker and shim | Conformance: the official `@modelcontextprotocol/sdk` client ↔ our shim ↔ the test broker. Ticket rejection, FIFO, close semantics, calls after close, the call limit, argument size, frame size, disconnect behavior, and a fuzz test on bridge frames. |
| Process | A fake binary that hangs, floods, stalls, writes huge lines, forks a grandchild: timers fire, and the whole group is killed. |
| Gateway | `CliAdapter` + `ReplayTransport` with `CliTurnOutcome` fixtures → `ChatResponse` (billing, cli, planUsage, costSource). |

**Fake CLI** (`packages/llm-gateway/test/fake-cli/fake-claude.mjs`):
- It prints `--version` as `2.1.260 (Claude Code)` and a `--help` that lists the required flags.
- It reads a JSON script from the `AICAD_FAKE_CLI_SCRIPT` environment variable.
- It launches the MCP server named in `--mcp-config`, exactly as Claude would. It then emits the Claude-dialect events (`init` with a tool list, `assistant` blocks, `user` results, `result`), making **real** MCP calls through the real shim and broker for each scripted tool call.
- It honors `--input-format stream-json` for nudges.

This lets the real `ClaudeCliProvider`, `CliAgentRuntime`, broker and `AgentRun` run end to end offline with a real or stub engine. Scenarios:
- the proposal is accepted, and the broker closes;
- `same_error`, which closes the broker, and the process is killed after the grace period;
- nudge, then the implicit proposal;
- cancel, and the group is killed;
- the budget gate stops the run;
- a tripwire fires (`init.tools` contains `Bash`).

**Gemini real-binary replay** (`test/cli/real-gemini.test.ts`, built): `describe.skipIf(!which("gemini"))`. It runs the installed binary through the real `GeminiCliProvider.detect()` and `run()`, with `--fake-responses-non-strict`, a throwaway `GEMINI_CLI_HOME` holding a fake API-key login (tests only), and a dead proxy for any other request. A run given no fake response fails with "No more mock responses …, got request: <json>", and Gemini writes that report, with the full request, into the workspace's TMPDIR. That is how the tests read exactly what the model would receive. It covers G1–G4, a plain completion, and mcp-submit end to end through a minimal MCP server (`test/cli/fake/mini-mcp.mjs`), including a control that shows the un-neutralized prompt IS expanded.

**opencode mock-provider harness** (`test/cli/real-opencode.test.ts`, built): `describe.skipIf(!which("opencode"))`. It uses isolated HOME/XDG dirs, a local OpenAI-compatible mock model server (`test/cli/real-harness.ts`), and a dead proxy. It covers O1, O2, the planted-parent-config check of §5.4 (with a control that shows the config IS loaded without `OPENCODE_DISABLE_PROJECT_CONFIG`), the model's tool list under deny-all, the agent prompt, session cleanup, and mcp-submit end to end.

**Recorded fixtures:** `AICAD_RECORD_FIXTURES=1` makes both harnesses write the raw stdout (paths scrubbed) to `test/cli/fixtures/{gemini,opencode}/real-*.jsonl`, which the parser tests use. The older Gemini, opencode, Codex and Cursor fixtures are hand-written from the documented formats; Codex and Cursor stay that way until someone can run them.

**Review round 2 additions.** The Gemini harness also plants a user hook for five events and an extension with its own hooks and a context file, and checks that no hook runs (run and cleanup) and that the extension context never reaches the request, with a control run without the switches; it checks the declared functions of the `mcp-submit` configuration (exactly `mcp_cad_submit_turn`); and it replays a hallucinated `classify` call (refused as `tool_not_registered`, a warning) and a `run_shell_command` call (still a violation). The opencode harness checks the global `AGENTS.md` / `instructions` residual risk, a hallucinated `classify` call (refused as unavailable, a warning) and a final `length` step (a truncated reply). `test/cli/review-round2.test.ts` replays the recorded streams (including the live Claude S1 hallucination, `claude/unoffered-tool-call.jsonl`) through fake binaries, `run()` and `LLMGateway`. The live smoke has **S1c**, which provokes the S1 failure mode on purpose.

### 13.2 Live gates

- **API live tests** keep their key gates.
- **CLI live tests** use their own gate:

```ts
const LIVE_CLI = new Set((process.env["AICAD_LIVE_CLI"] ?? "").split(",").filter(Boolean));   // e.g. "claude"
describe.skipIf(!LIVE_CLI.has("claude"))("claude-cli live smoke", …);
```

### 13.3 Live smoke profile `cli-smoke-claude` (frozen)

**Run on demand only:** `AICAD_LIVE_CLI=claude pnpm --filter @aicad/agent test:live:cli`. Never in CI, never in watch mode, never in parallel.

| Step | What | Model calls | Asserts |
|---|---|---|---|
| S0 | detect, version, lockdown, auth | 0 | status `ready`; lockdown `verified` or `static`; auth `logged_in`. If not, **skip the rest** with the reason. |
| S1 | Completion: triage "make the plate 2 mm thicker" with `claude-cli:haiku`, envelope via `json-schema` | 1 invocation (≤ 3 turns) | `init.tools` = `["StructuredOutput"]`; `classify` parsed; `billing` = `subscription`; costSource `provider`; no session dir left behind |
| S1c (added, review round 2) | Completion as S1, but the system prompt asks for a direct `classify` call first (§5.6 amendment 2) | 1 invocation (≤ 3 turns) | No failure; when the model called `classify` directly, a "not a lockdown violation" warning; `classify` parsed from the envelope. Recorded 2026-09-24 on 2.1.260: Haiku called `classify`, Claude refused it, the envelope arrived on turn 3. |
| S2 | Runtime: forced `quick_edit` on the NEMA 17 fixture ("make the plate 2 mm thicker"), designer `claude-cli:haiku`, BUILD limits `{maxTurns: 8, wallMs: 180_000}`, budget notional $0.25 | 1 invocation | Tripwire passed (`init.tools` ⊆ `mcp__cad__*`); ≥ 1 `apply_cadscript` through the broker; the run ends `proposed`, or stopped with a verified state; the broker closed; the process group is gone; the workspace is deleted; one external ledger charge |
| S3 (optional, `AICAD_LIVE_CLI_SPEC=1`) | Runtime SPEC on the same request | 1 invocation | `submit_spec` accepted; fresh session |

- **Expected spend:** about $0.02–0.08 notional on Haiku for S1 + S2.
- **The suite aborts before S1** if the cached or first-seen plan usage has `status ≠ "allowed"` or five-hour utilization ≥ 0.8.
- Each step prints its notional cost and the plan-usage delta.
- Quality (whether Haiku gets the task right) is informational. The smoke checks the plumbing.

### 13.4 Bench over CLI providers

- **`aicad-agent run|bench`** accept CLI profile ids for `--designer-model`, `--spec-model`, `--triage-model` and `--models`, plus `--cli-mode auto|completion|runtime` and `--cli-bin <provider>=<path>`.
- **`bench` on subscription profiles** defaults to `--concurrency 1` and requires `--limit`. The default limit is 5; `--limit 0` means all, with a confirmation line printed. A full MakerBench pass on Opus costs about 60 × $0.75 ≈ $45 notional, and it would exhaust a plan's five-hour window.
- **`comparisonTable`** labels subscription cost as "≈$ (plan)" and adds a `mode` column.
- **The leaderboard** may rank CLI profiles, but nightly and weekly CI runs use only API keys or local models, never a person's plan.

---

## 14. Build waves

**Constraints for every wave:**
- Do not touch `forge/**`, `oracle/**`, `packages/cadscript/**`, `packages/forge-web/src/**`, or existing files under `packages/desktop/e2e/**`; the IR v1 workflow owns them.
- No git state changes unless asked.
- Keep temporary files small, and delete them.
- Never read CLI credentials.

**Wave 1: gateway core and Claude completion mode**
- **Files.** In `llm-gateway/src/`:
  - modified: `types.ts`, `errors.ts`, `profile.ts`, `budget.ts`, `gateway.ts`, `adapters/adapter.ts` (`finalizeResponse` billing), `builtin-profiles.ts` (`claude-cli:*`);
  - new: `cli/{provider,events,mcp,env,workspace,process,detect,lockdown,envelope,adapter,transport,claude,index}.ts`;
  - `package.json`: the `./cli` export.
  - In `agent-tools`: `ToolRegistry.defs()` sets `readOnly`.
- **Tests:** §13.1 for Claude (parsers, args, lockdown, env, envelope, process, adapter replay), and snapshot updates.
- **Accept when:**
  - `pnpm -r build && pnpm -r test` is green;
  - live S0 and S1 pass.

**Wave 2: MCP server and runtime mode (Claude)**
- **Files.**
  - New `packages/mcp-server/**`.
  - `agent/src/{runtime.ts, cli-runtime.ts}` (new).
  - Modified: `agent.ts`, `spec-writer.ts`, `run-context.ts`, `trace.ts`, `models.ts` (uses `smallModelFor`), `solver.ts`, `index.ts`, `package.json` (the `./cli-runtime` export).
  - The fake CLI.
- **Tests:** broker, shim and SDK conformance; the fake-CLI scenarios in §13.1.
- **Accept when:**
  - offline green;
  - live S2 passes (S3 optional);
  - the stdin stream-json nudge is verified (§15 A1).

**Wave 3: desktop, app and Ollama**
- **Files.**
  - In `desktop/src/agent/`: `cli-detect.ts` (new); modified `settings.ts`, `host.ts`, `runner.ts`, `protocol.ts`, `keys.ts` (API ids only).
  - Modified: `desktop/src/env.ts`, `desktop/src/main.ts` (worker env names, exe path), `app/src/agent-protocol.ts`, `app/src/ui/SettingsDialog.tsx`, `app/src/agent/agent-service.ts`, `commands/commands.ts`.
  - New in `llm-gateway`: `adapters/ollama.ts`, `transport/ollama.ts`, `local/ollama-discovery.ts`.
  - Docs: an AGENT-IN-APP.md providers section.
- **Tests:** detector (fake binaries), precheck codes, protocol validation, settings view, Ollama adapter and transport with fixtures.
  - **No edits to existing e2e files.** A new `e2e/providers.e2e.ts` waits until the IR v1 workflow releases `packages/desktop/e2e/`.
- **Accept when:** the app runs a Claude Code task end to end with **no API keys** configured, and the Settings statuses are correct.

**Wave 4: Gemini, Codex, opencode and Cursor (blocked), plus discovery and bench**
- **Files:** `llm-gateway/src/cli/{gemini,codex,opencode,cursor}.ts`, `listModels`, discovery → profiles, `agent/src/cli-main.ts` flags, `bench.ts` columns, and fixture sets.
- **Tests:** parser, args and lockdown fixtures for each CLI; Gemini real-binary replay when installed; an opencode mock-provider harness (the research method: isolated XDG, mock OpenAI-compatible server) when installed.
- **Accept when:**
  - offline green;
  - Gemini G1–G3 and opencode O1–O2 are verified locally (§15). **Status 2026-09-24:** G1–G4, O1 (MCP merge and `{env:VAR}`) and O2 (`--pure`) are verified by the real-binary harnesses (§13.1); the O2 MCP call-timeout part stays open;
  - Codex stays `static`;
  - Cursor stays blocked.

---

## 15. Open verification items

Each item must be closed, or its spec amended (§16), in the wave shown.

| Id | Wave | Item | How to close it |
|---|---|---|---|
| A1 | 2 | Claude `--input-format stream-json`: the user message shape, multi-turn continuation after `result`, `closeInput()` exit, image blocks | Live S2 plus one nudge; record fixtures |
| A2 | 1 | Claude login-failure stderr text and exit code; result shape on a 429 or plan limit (`api_error_status`, `rate_limit_event.status: "rejected"`) | Logged-out run in a throwaway `CLAUDE_CONFIG_DIR` (no model call); a 429 from a recorded fixture when observed |
| A3 | 2 | `--max-budget-usd` on subscription logins (notional basis?) | Tiny cap in S2; expect `error_max_budget_usd` |
| A4 | 1 | `--max-turns` counting with `stream-json` input: per message or per process | S2 with `maxTurns` 2 |
| A5 | 2 | `MCP_TOOL_TIMEOUT` covers a 10-minute `ask_user` wait | Fake CLI cannot test it; a live interactive check once |
| G1 | 4 | Workspace `tools.core` vs a user-level `tools.core`: union or replace | **Closed 2026-09-24** (0.49.0, real-binary replay): the workspace `[]` wins; the request declares `functionDeclarations: []` although the user level lists `run_shell_command`, `read_file` and `write_file`. |
| G2 | 4 | `@aicad/std` or `@../x` in stdin prompts: expansion, errors, aborts; `neutralizeAtPaths` effectiveness | **Closed, spec amended**: a fenced `@<included dir>/file` IS read into the request (fences are not special), so every `@` is now neutralized in every mode; with it nothing is read. A missing `@aicad/std` did not abort the run in the replay. |
| G3 | 4 | `${…}` substitution in `GEMINI_SYSTEM_MD` files beyond the known placeholders; `context.fileName` override hides `GEMINI.md` | **Closed, amended**: `$\u200b{HOME}` reaches the model verbatim and the system prompt replaces Gemini's own. A planted `GEMINI.md` or old-name context file in a parent folder is not loaded, but the user's global `~/.gemini/GEMINI.md` still is (residual risk). The context file name is now per run. |
| G4 | 4 | `--delete-session` from a fresh `aicad-run` directory removes the session | **Closed, amended**: false as specified. Sessions are keyed by the full path, so cleanup runs in the invocation's own workspace. Session ids must start with a letter and carry no `-` in their first 8 characters (the `parseInt` index fallback, the short-id rule). Verified: the session file is removed, and no prompt text is left under `~/.gemini`. |
| X1 | 4 | Codex: is the MCP server spawned inside the read-only Seatbelt profile, and can it connect to a Unix socket there? | Needs an installed Codex; until then level `static` and Codex runtime marked experimental in Settings |
| X2 | 4 | Codex `delete` command shape; `turn.completed.usage` after `resume` | Same. Until then cleanup runs only when `codex --help` lists `delete`. |
| O1 | 4 | opencode: partial `mcp.<user server>: {enabled:false}` merges cleanly; `{env:VAR}` in `environment` | **Closed 2026-09-24** (1.17.10, mock-provider harness): the user's server is not started; the ticket reaches the MCP server through `{env:AICAD_MCP_TICKET}`. |
| O2 | 4 | opencode `--pure` semantics; MCP tool-call timeout setting (else `ask_user` stays out of scope) | `--pure` **closed**: it keeps global plugins (`plugin/`, `plugins/`) from loading; without it they load. The MCP call-timeout part stays **open**, so `ask_user` stays out of the opencode runtime scope. |
| C1 | 4 | Cursor: first build with `--trust` and `status --format json`; a way to disable web search; whether `deny` hides tools | Needs a Cursor plan: a maintainer-run verification. Until then, blocked. |
| W1 | 3 | Windows: named-pipe broker, `.cmd` shim resolution, Claude `--system-prompt-file` and `--json-schema` length | Windows CI (offline, fake CLI) |

---

## 16. Change log

| Date | Change |
|---|---|
| 2026-09-24 | Initial frozen design (ADR 0014). |
| 2026-09-24 | **Additive interface changes made during waves 1–4, recorded after review:** `CliCommand.files[].encoding` (`"base64"` for image bytes); `CliRunIO.onStdoutLine` (fixture recording); `CliRun.extendWall`; `ChatRequest.providerOptions.cli.limits` (per-call `CliLimits` overrides); `BUILTIN_CLI_PROFILES` and `BUILTIN_LOCAL_PROFILES` as exports separate from `BUILTIN_PROFILES` (§14 wave 1 lists `claude-cli:*` in `builtin-profiles.ts`; they live there, but in their own export, so API-only hosts such as the current desktop do not list profiles they cannot run). |
| 2026-09-24 | **ADR-level: Ollama over `openai-compat` (§10 amended).** Local profiles are `openai-compat` + `local` + `billing: "local"`, not provider `ollama` with a native `/api/chat` adapter. Mitigations: `ollamaContextCheck()` (a `/api/ps` context check that warns below `local.numCtx`), `profileKind()` and `smallModelForProfile()` for routing and prechecks. The native adapter stays the target. |
| 2026-09-24 | **Review fixes (security):** workspace and probe roots with private ancestors only (`unsafeAncestor`, `setDefaultWorkspaceRoot`, `createProbeDir`; §5.4); opencode `OPENCODE_DISABLE_PROJECT_CONFIG=1` on runs, probes and cleanup, plus `--pure` on probes and cleanup; Gemini per-run context file name; every `@` neutralized in every Gemini prompt (`restoreAtPaths` added); Codex tripwire as an item-type allowlist; opencode tool calls at first sighting; flag-like argv values rejected and values passed as `--flag=value` (§5.7; lockdown checks now require the long flag forms); `binaryRefusal` enforced inside `BaseCliProvider.run()` too (§5.5); `kill("lockdown")` always sets `lockdown_violation` (§5.6); tripwires documented as detect-only (§5.6, §5.9). |
| 2026-09-24 | **Review fixes (correctness):** one final-text rule (`finalAssistantText`) for the transport and the adapter (Gemini plain completions returned no content); the Gemini result carries the text since the last tool activity and derives thinking tokens from `total_tokens`; opencode treats a final `stop` step as success after recovered errors; Claude lists models by output tokens and the adapter reports the in-family model, warning only when none matches; additive `CliRun.brokerBusy(on)` pauses the stall timer during broker calls (§5.8); the start timer never outlives the extended wall clock. |
| 2026-09-24 | **Review fixes (sessions):** Gemini cleanup runs in the invocation's own workspace, deletes only a CLI-reported, letter-first session id (`geminiSessionId`), and never uses `--list-sessions` (a possible model call); Codex cleanup only when `--help` lists `delete`. §15 G1–G4, O1 and O2 (`--pure`) closed by the real-binary harnesses (§13.1). |
| 2026-09-24 | **Review round 2 (lead decision: §5.6 amendment 2).** A call to a tool the CLI does not have is a warning, not a lockdown violation: Claude via its checked `init` tool list (`TripwireContext.reportedTools`); Gemini and opencode via a held call and the parser's `tool_result.unavailable` (`TripwireContext.builtinTools`, `GEMINI_BUILTIN_TOOLS`, `OPENCODE_BUILTIN_TOOLS`); Codex and Cursor unchanged (fail closed). Additive: `TripwireMonitor`, `isUnofferedToolCall`, `tool_result.unavailable`, `CliCommand.warnings`, `CLI_IMAGE_EXTENSIONS` / `cliImageFileName` / `isCliImageMediaType`. **Gemini:** `hooksConfig.enabled: false` + `--extensions=none` on runs, `--extensions=none` on cleanup, `--extensions` required by the lockdown (the user's and extensions' hooks ran, and extension context reached the model, before). **Images:** media types checked at runtime; file extensions from a fixed map. **opencode:** `mcp list` parser only reads per-server lines (the empty list produced a bogus `Add` server); a final `length` step is a truncated reply, `content-filter` a refusal; global `AGENTS.md` / `instructions` disclosed. **Plain completions** take `max_tokens` / `refusal` from the last turn. **Optional flags:** `--effort` (Claude) and `--variant` (opencode) only when `--help` lists them, else a warning. Gemini's per-run `projects.json` growth disclosed (§5.9). |

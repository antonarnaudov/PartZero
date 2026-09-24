# The design agent in the desktop app

This doc covers how the Assistant panel runs `@aicad/agent` on the open document and hands back a reviewable **draft** (ARCHITECTURE §6–§7). It explains where the models come from (CLI agents on your own subscription, local models, or optional API keys; [ADR 0014](adr/0014-cli-agents-as-providers.md)), where keys are stored, and how to run the agent offline with the scripted transport or a fake CLI.

Everything up to [Planned: approved North Star changes](#planned-approved-north-star-changes) describes what runs today. That section lists the agent and hands-on UX changes the owner approved on 2026-09-24 ([NORTH-STAR.md](NORTH-STAR.md)). None of them is built yet.

![A proposal under review: the per-feature change list, the CadScript diff and the proposal preview in the viewport](spikes/assets/agent-proposal.png)

## Quick start

1. Run the app with `pnpm --filter @aicad/desktop dev`.
2. Have a model provider. **No API key is needed** if you already use one of these:
   - a CLI coding agent you are logged into: Claude Code (`claude`), Codex CLI, Gemini CLI or opencode. The app detects it and uses your own plan (see [Providers](#providers-cli-agents-local-models-and-optional-api-keys));
   - a local Ollama server with a tool-capable model (`ollama pull qwen3:8b`).

   Otherwise open **Settings** (⌘, or the gear icon) and paste an API key for Anthropic, OpenAI or Google Gemini, or point the app at an OpenAI-compatible endpoint. Settings shows what was found, e.g. "Using Claude Code (detected)".
3. Optionally select a face or feature, then type a request in the Assistant, e.g. "make the plate 2 mm thicker".
4. Follow the progress checklist, the cost meter and any questions. Then review the **Proposal** tab: the diff, the per-feature checkboxes and the viewport preview.
5. Click **Accept** (or **Accept n of m**). The change lands as **one undo step**, and ⌘Z reverts it. Today every agent change lands this way. The planned [autonomy dial](#the-autonomy-dial) adds two more settings at Phase 1 beta.

## Process layout

```
renderer (sandboxed React app)            main process                         agent utility process
──────────────────────────────            ────────────                         ─────────────────────
AgentService + commands  ── invoke ──▶    AgentHost                ─ post ─▶  AgentRunner
 agent.run / stop / answer  agent:start    · validates requests (v1)            · LLMGateway (keys in memory,
 settings.*                 agent:answer   · settings + key store                 CLI transports, local models)
                            agent:stop     · CliDetector: CLI version,          · @aicad/agent (interactive)
                            settings:*       lockdown, login (no model call)    · Engine: forge-web WASM in
                                           · LocalModels: Ollama probe            Node → Forge CLI fallback
                                           · start precheck, keys per run       · CLI child processes, one per
                                           · forks / re-forks the worker          model call (own process group)
ProposalView, RunCard  ◀── agent:event ──  forwards events            ◀ post ─  events (phase, tool, llm,
viewport preview                           (+ crash / stop-timeout,             cost, plan, draft, question,
                                           plan-usage cache, CLI blocks)        result) + lockdown / pgid reports
```

**Why a utility process** (`utilityProcess.fork`) rather than the main process:
- An agent run compiles and type-checks CadScript (the TypeScript compiler) and evaluates Forge WASM, synchronously, often for seconds at a time. In the main process that would stall IPC, menus and the `app://` protocol for every window.
- A crash, OOM or runaway loop in a provider SDK or in WASM would take the whole app down. Here it only ends the run. The main process reports `WORKER_EXITED` to the renderer and forks a fresh process for the next run.
- The process gets a **sanitized environment**: no `*_API_KEY`, `*_TOKEN` or `*SECRET` variables. It receives only the keys a run needs, in the `start` message. Its own environment is the plain allowlist (`env.ts` `agentWorkerEnv`): no base-URL, Node, proxy or CA overrides. Where CLI agents keep their own logins (`XDG_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`: locations, never credentials) and the proxy and CA settings a CLI may need (`HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_*`, `NODE_EXTRA_CA_CERTS`) travel in the `start` message (`WorkerCliConfig.childEnv`) and reach **CLI children only**; the gateway allowlists again for every CLI child (docs/CLI-PROVIDERS.md §5.3). Trade-off: a CA or proxy set in the app's environment (for example with `launchctl setenv`) still reaches the CLIs, which need it behind a corporate proxy, but never the process that holds the API keys and makes the SDK calls.

The renderer stays sandboxed and CSP-locked (`connect-src 'self'`). It never talks to a provider.

**Engine.** The agent verifies every step (L0 compile → L1 kernel → L2 expectations → L3 tests) against `@aicad/forge-web`. That is the same WASM build the viewport uses, run in Node inside the utility process. If it is missing, the agent uses the native Forge CLI (`aicad`). With neither, the run stops with `engine_unavailable`.

## IPC protocol (version 1)

- **Where the types live:** `packages/app/src/agent-protocol.ts`, exported through `@aicad/app/bridge`.
- **Runtime validation:** `packages/desktop/src/agent/protocol.ts`.
- **Versioning:** every message carries `v: 1`. The main process rejects any other version, as well as unknown enums and oversize fields, and it drops unknown fields.

| Channel (renderer → main) | Request | Response |
|---|---|---|
| `agent:start` | `{ v, prompt, source, documentName, selection[{kind, ref, label, description}], process?, settings?{budgetUsd} }` | `{ ok: true, runId }` or `{ ok: false, code, message }` with `code` one of `NO_API_KEY`, `CLI_NOT_INSTALLED`, `CLI_UNSUPPORTED`, `CLI_BLOCKED`, `CLI_NOT_LOGGED_IN`, `LOCAL_UNAVAILABLE`, `BUSY`, `INVALID_REQUEST`, `UNAVAILABLE` |
| `agent:answer` | `{ v, runId, questionId, answers[] }` | `{ ok }` |
| `agent:stop` | `{ v, runId }` | `{ ok }` |
| `settings:get` / `settings:update` / `settings:setApiKey` / `settings:clearApiKey` | see `SettingsUpdate` (models, budget, compat URL, `cliPaths`, `cliMode`, `ollamaBaseUrl`), `SetApiKeyRequest`, … | `AgentSettingsView` (never contains a key or any CLI credential) |
| `settings:probeProviders` | `{ v, providers? }` | `AgentSettingsView`, after detecting the CLIs and Ollama again (no model call) |

`agent:event` (main → renderer) streams `AgentEvent`s. Each one carries `{ v, runId, seq, t }` plus one body:

| `type` | Meaning |
|---|---|
| `started` | Models per role, budget, transport (`live` \| `scripted` \| `replay`), engine |
| `phase` | Orchestrator state: TRIAGE, CLARIFY, SPEC, BUILD, REPAIR, REPLAN, PROPOSE, DONE, and its detail |
| `tool` / `llm` / `note` | Summarized tool calls, model calls with cost (and their `billing`: metered, subscription or local), orchestrator notes |
| `cost` | `spentUsd` and `budgetUsd` (the cost meter); `notional: true` when the spend is a CLI plan's list-price estimate |
| `plan` | Plan usage a CLI reported (Claude Code: 5-hour and 7-day windows) |
| `draft` | A CadScript snapshot after every apply or rollback (the live "Draft" tab) |
| `question` / `answered` | Clarifying questions with options and defaults. The 80 % budget checkpoint arrives as `kind: "budget"` |
| `result` *(terminal)* | See below |
| `error` *(terminal)* | `WORKER_EXITED`, `STOP_TIMEOUT`, `RUN_FAILED`, … |

A `result` carries `status`, `stopReason`, `baseSource`, `proposedSource`, `changed`, `verified`, `summary`, `assumptions`, `knownIssues`, `answer?`, `tests?`, `costUsd`, `budgetUsd`, `latencyMs`, `turns` and `billing` (the designer's profile). Every change since v1 shipped is additive: the version stays 1.

**Stop.** The Stop button aborts the run's `AbortSignal`, which also aborts in-flight provider requests. The agent ends with stop reason `cancelled` and hands back its best verified state as the proposal. If the process does not wind down within 8 s, the main process kills it (`STOP_TIMEOUT`).

## Commands

Everything the UI does goes through the command layer, the same one the agent and MCP use.

| Command | What it does |
|---|---|
| `agent.run { prompt, chips? }` | Starts a run. `chat.send` delegates to it. Chips default to the current selection. |
| `agent.stop` (⌘.) | Stops the active run. |
| `agent.answer { answers[] }` | Answers the open question. An empty answer takes the default. |
| `agent.setAccepted { features[] }` | Ticks changes. This updates the diff, the dependency warnings and the preview. |
| `agent.accept { force? }` | Applies the whole proposal as **one** undoable transaction. |
| `agent.acceptFeatures { features[], force? }` | Applies a subset. It refuses selections that break dependencies unless `force` is set. |
| `agent.reject` | Discards the proposal. |
| `agent.setPreview { enabled? }` | Toggles the proposal preview in the viewport. |
| `agent.showProposal` | Opens the Proposal tab. |
| `settings.open` (⌘,) | Opens the Settings dialog. |
| `settings.setApiKey { provider, key }` | Stores a key. The command is marked `sensitiveArgs`, so execution records show `[redacted]`. |
| `settings.clearApiKey`, `settings.setModel { role, model \| null }`, `settings.setBudget { usd }`, `settings.setCompatBaseUrl { url \| null }` | Change the other settings. |
| `settings.probeProviders { providers? }` | Re-check: detect the CLI agents and Ollama again (Settings → Re-check). No model call. |
| `settings.setCliPath { provider, path \| null }` | Use this binary for a CLI agent (absolute path to the CLI itself); null restores automatic detection. |
| `settings.setCliMode { mode }` | `auto` (recommended), `completion` (single calls only) or `runtime` (the CLI's own agent loop). |
| `settings.setOllamaUrl { url \| null }` | The local Ollama server (https, or http on localhost); null restores `http://127.0.0.1:11434`. |

**Selection chips.** Selection chips are sent as semantic context, for example ``face `plate/cap:end` — the end cap (the face at the far end of the extrusion) of extrude `plate` of sketch `outline`, 5 mm``. The designer receives them in a `<selection>` block after the request.

**Review.** The proposal is diffed per feature (by part and feature name): added, modified or removed. This is the only way agent work lands today. It becomes the default setting, **Propose per feature**, of the planned [autonomy dial](#the-autonomy-dial).
- **Dependency-aware rejection.** Rejecting a sketch that an accepted extrude uses is an **error** that names the fix. So is accepting the removal of a sketch that a kept feature still uses. Accepting a change without the sketch change it was made with is a **warning**.
- **Building the result.** The accepted subset is built on the IR and spliced into the CadScript with `applyIrEdit`, so untouched code and comments survive.
- **Edits during a run.** If you edited the document during the run, the accepted changes are rebased onto your edits, and any conflicts are reported.

## Providers: CLI agents, local models and optional API keys

Every model is a gateway profile of one of three kinds (ADR 0014, docs/CLI-PROVIDERS.md). **API keys are optional.**

| Kind | Providers | Who pays | Shown in Settings as |
|---|---|---|---|
| CLI agent | Claude Code, Codex CLI, Gemini CLI, opencode (Cursor Agent: detected, not supported yet) | Your own subscription, through the CLI you installed and logged into | **CLI agents (your subscription)** |
| Local | Ollama | Nobody: it runs on this computer | **Local models (Ollama)** |
| API | Anthropic, OpenAI, Google Gemini, OpenAI-compatible | Per token, on your key | **API keys (optional)** |

**Detection (main process, `cli-detect.ts`).** For each CLI the app finds the binary (the Settings path, else `PATH`, the usual install folders such as `~/.local/bin` and `/opt/homebrew/bin`, and once per session your login shell), reads `--version` and `--help`, and checks that the version can be locked down. A cheap login probe follows (`claude auth status --json`, …). **No probe calls a model, and the app never reads a CLI's credentials**: only the login state, the method and the plan name ("Max") are kept; e-mail and account ids are dropped unread. Detection is cached for 10 minutes (and redone as soon as the binary changes on disk, since CLIs update themselves), logins for 60 s, the Ollama probe for 30 s. **Re-check** redoes all of it. It also runs once in the background shortly after the app starts. A Settings path is checked again before every detection (absolute, the CLI's own name, an executable file); a stored path that fails is shown as not installed with the reason. A probe of an Ollama URL that changed in the meantime is dropped, never shown for the new URL.

**Badges.** Ready (supported, locked down, logged in) · Log in needed · Update needed · Blocked (a run caught it breaking its lockdown; Re-check tests it again) · Not supported yet (e.g. Cursor Agent, whose web search cannot be switched off in headless runs) · Not installed (with an install link). Each row shows the path it uses (**Change…**), the login state, the plan usage the CLI last reported (Claude Code: 5-hour and 7-day bars), and a **Details** disclosure with the lockdown level and the residual risks.

**Defaults.** When you have not chosen models, they come from the first *ready* provider in this order: Claude Code, Codex, Gemini CLI, opencode, then the Anthropic, OpenAI and Google keys, then Ollama. With Claude Code that is Opus (designer and spec writer), Haiku (triage) and Fable (judge); Settings says "Using Claude Code (detected)". If nothing is ready but a CLI only needs a login, or a Re-check after a lockdown block, it is still the default, so a run asks you to log in (or to press Re-check) rather than for a key. The model pickers list every profile grouped by provider with its kind (Plan, Local, API key); unavailable ones are disabled with the reason. Choosing only the designer makes the spec writer follow it and triage use that provider's small model (e.g. `claude-cli:haiku`), so a run needs one provider.

**Start precheck (`AgentHost.start`).** Every provider the run's models use must be usable, or the run is refused with the provider, the roles and the fix, plus an **Open Settings** action: `CLI_NOT_INSTALLED`, `CLI_UNSUPPORTED` (update it), `CLI_BLOCKED`, `CLI_NOT_LOGGED_IN` ("Claude Code is installed but not logged in … Run `claude auth login` in a terminal, then press Re-check."), `LOCAL_UNAVAILABLE` (Ollama not running, model not pulled, or no tool calling), `NO_API_KEY`. A CLI whose login state is unknown is allowed; the run fails fast if it is really logged out.

**How a CLI run works.** The worker gets the detected binary and builds the gateway's CLI transport (`@aicad/llm-gateway/cli`). In **completion mode** (docs/CLI-PROVIDERS.md §3.1) every model call is **one fresh CLI invocation**: the CLI's built-in tools off (Claude Code: `--tools ""`, `--restricted`, `--strict-mcp-config`, no session persistence, no hooks, no `CLAUDE.md`), an empty `0700` workspace that is deleted afterwards (under `<userData>/cli-work`, or a shorter private folder, below), an allowlisted environment with no keys or tokens, the prompt on stdin (never in argv), its own process group, and wall/stall timeouts. The model answers with a turn envelope (Claude Code: `--json-schema`), and the orchestrator runs the CAD tools exactly as for an API model. Never `--bare` (it would switch off your subscription login).
- **Agent-runtime mode** (§3.3) is what **Automatic** (the default) uses where it is available, i.e. development builds today: triage and other single-shot calls stay completion calls, and each SPEC / BUILD / ASK phase is **one** locked-down CLI process running its own loop, whose only tools are our CAD tools, reached through the MCP broker in the worker and the `cad` server the CLI launches (`ELECTRON_RUN_AS_NODE=1 <app> stdio.js`). Every tool call still goes through the orchestrator's verification ladder, stop rules and budget gate. **Single calls only** forces completion mode; **Agent runtime** requires the runtime and stops the run at the first tool loop when it is unavailable, saying why. Packaged builds cannot run the shim yet (below), so there Automatic means single calls.
- **The workspace root** must be private all the way up (another local user must not be able to write to any folder above it: opencode reads `opencode.json`, `.opencode/` and `AGENTS.md` from every folder above its working directory, and other CLIs discover context files the same way) and should leave room for the broker socket `<root>/s/<8 hex>/b.sock` (103 bytes on macOS). The app uses `<userData>/cli-work` when both hold. When the data folder is too long (a long home folder, or a test profile under `$TMPDIR`) or sits under a folder others can write to, it uses this profile's own folder in the gateway's private default root instead (on macOS the per-user `/var/folders/…/T/aicad-cli/app-<hash>`; never a shared `/tmp`). With neither: a data folder that is only too long keeps `<userData>/cli-work` and the worker runs CLI providers one call at a time, saying so up front; a data folder under a shared folder turns CLI providers off, and Settings and the start precheck say why.
- **The root belongs to one app instance** (the single-instance lock is per data folder, and the fallback is per profile), so the app empties it at start (what a crashed or killed session left) and on quit: a runtime phase or CLI call interrupted by quitting leaves no workspace behind (its system prompt, image attachments, the CLI's temp or crash files). The worker's 24-hour sweep stays as a backstop.
- **Lockdown checks** run on the event stream, in both modes: if a CLI exposes or calls a tool it must not have, the run stops (`lockdown_violation`), that CLI gets no further call in the run, and the main process marks that exact binary (real path, size, mtime) **blocked**. The block is saved in `agent-settings.json`, so it survives a restart; only a Re-check that passes, or the binary changing on disk (an update, which is detected and version-gated again), lifts it. Blocks on files that no longer exist (an old versioned binary the updater removed) are dropped, and at most the 32 newest are kept.
- **The binary is re-checked before every spawn**: a CLI that updated itself since detection is refused until Re-check.
- **Process groups** are killed on Stop, on timeouts, on quit and when the worker exits; the worker reports their ids so the main process can kill them if the worker crashes (only that worker's: a worker replaced after a stop timeout never takes its successor's CLIs with it).
- **Gemini CLI and opencode** return their envelope through the `submit_turn` tool of our MCP server (`@aicad/mcp-server`), which the CLI launches as `ELECTRON_RUN_AS_NODE=1 <app> stdio.js`. When that server is unavailable they fall back to a strict JSON reply. Claude Code needs no MCP server for single calls.
- **Stop** during a CLI call or a runtime phase kills the process group (the runtime's MCP server with it), removes the workspace and ends the run `cancelled`.

**Plan usage and cost.** CLI runs are not billed per token, but they count against your plan's limits. The per-task budget still applies, as **notional** cost at API list prices: Claude Code reports it itself (`total_cost_usd`). The run card shows "≈ $0.016 plan usage / $1.00" with "(API list price; not billed)" and the plan windows Claude Code reported ("Plan: 5-hour 17 % · 7-day 5 %"), and the 80 % checkpoint reads "About 80 % of this task's plan-usage budget is spent…". A CLI logged in with an API key is billed per token and says so. Plan usage from runtime phases is reported the same way (one `plan` event per distinct report). Settings keeps the last plan usage; a limit reached at the last run is a warning, never a start error. When a run stops because the plan's limit is used up, the run card says "Stopped: plan usage limit reached" with the reset time the CLI reported (`AgentRunResult.quota`), and the result message carries the same time. That time, like the one in the Settings warning and the next run's note, is the reset of the window that ran out (utilization at 100 %, else the fullest window), not the latest reset among the windows: Claude Code usually runs out of its 5-hour window while the 7-day window resets days later.

**Data.** Prompts and your design go to the CLI's vendor under your plan's terms (consumer terms, not API zero data retention). Settings shows this next to the CLI list.

**Local models (Ollama).** The app probes `http://127.0.0.1:11434` (or the URL in Settings: https, or http on localhost), lists the models that support tool calling, and never pulls a model: Settings shows the `ollama pull <tag>` command for the suggested ones. Local profiles reach Ollama through its OpenAI-compatible `/v1` endpoint, without the compat key and regardless of the compat base URL. Because `/v1` cannot set the context size, the worker checks the loaded context (`/api/ps`) before and during a local run and warns when it is below what the profile needs (fix: `OLLAMA_CONTEXT_LENGTH`).

## API keys: storage and security

- **Where keys are stored.** Keys you enter in Settings are encrypted with Electron **`safeStorage`**, which uses the macOS Keychain, Windows DPAPI, or libsecret/kwallet on Linux. Only the ciphertext is written, to `<userData>/agent-keys.json` with mode `0600`. The `userData` folder is:
  - macOS: `~/Library/Application Support/aicad/`
  - Windows: `%APPDATA%\aicad\`
  - Linux: `~/.config/aicad/`
- **If there is no real encryption.** On a Linux system with no keyring, `safeStorage` falls back to `basic_text`. The app then **refuses to store keys** and tells you to use environment variables.
- **What the renderer sees.** The renderer only ever sees `configured`, the source (`keychain`, `env` or `dotenv`) and the last four characters. The last four are shown only for keys of 16 characters or more. A key typed in Settings crosses from the renderer to the main process once. The field is cleared right away, and the key never comes back.
- **Where plaintext keys exist.** A plaintext key exists only:
  - in main-process memory, while a run starts;
  - in the agent process, for the duration of a run.

  Keys are never logged. The agent process scrubs every outgoing event string of the run's keys, and the main process masks anything key-shaped in worker log lines.
- **Other secret stores.** Keys are never put in `localStorage`, in settings JSON, in URLs or in the renderer.
- **Development.** Keys can also come from the environment or from the repo-root `.env`, which is gitignored (see `.env.example`). The variables are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and `OPENAI_COMPAT_API_KEY`.
  - Precedence is **Settings (keychain) → environment → `.env`**.
  - `.env` is never read in packaged builds.
  - `AICAD_AGENT_DOTENV=<path>|off` overrides or disables it.
- **Non-secret settings.** These live in `<userData>/agent-settings.json`: the model per role (designer, spec writer, triage, judge), the budget per task (default **$1.00**), the OpenAI-compatible base URL, CLI path overrides, the CLI mode, the Ollama URL and the CLI binaries blocked after a lockdown violation (provider, real path, size, mtime, reason). On load, a CLI path that is not absolute or does not have the CLI's own name is dropped, like a Settings update would refuse it.
  - When you change only the designer, the spec writer follows it and triage uses that provider's small model. A run then needs exactly one provider (one key, or none for a CLI agent or a local model).
  - The judge is stored for the L5 visual review, which is not wired into the agent yet.

## Running without keys: the scripted transport

The scripted transport replays genuine Anthropic stream events from a JSON script through the real gateway (pricing, budget, ledger) and the real orchestrator and engine. It makes no network calls and needs no keys.

```bash
AICAD_AGENT_TRANSPORT=scripted \
AICAD_AGENT_SCRIPT=$PWD/packages/desktop/e2e/fixtures/nema17-thicker.script.json \
pnpm --filter @aicad/desktop dev
# then: New from template → "NEMA 17" → "Make the plate 2 mm thicker"
```

A script file looks like `{ "paceMs"?: number, "triage"?: ScriptTurn[], "spec_writer"?: ScriptTurn[], "designer"?: ScriptTurn[] }`:
- The turns are `@aicad/agent` `ScriptTurn`s: `text`, `tools[{name, input}]`, `stop` and `usage`.
- `paceMs` delays every model call so the progress is easy to watch, and Stop can interrupt the delay.
- Every run replays the script from the start.
- `AICAD_AGENT_TRANSPORT=replay` together with `AICAD_AGENT_FIXTURES=<fixtures.json>` replays recorded gateway fixtures (`Fixture[]`, sequential) instead.
- In both offline modes, Settings shows a banner, and model settings are ignored (the scripts speak the Anthropic format).

## Running without keys or CLIs: the fake Claude Code

`packages/desktop/e2e/fake-cli.ts` writes a fake `claude` (a two-line Node wrapper around `e2e/fixtures/fake-cli/fake-claude.mjs`). It answers `--version` (2.1.260), `--help` (the recorded help of the real 2.1.260), `auth status --json` (logged in with a Max plan, or logged out) and every model call with stream-json in the shape recorded from the real CLI, taking the envelopes from the same script the scripted transport replays (`e2e/fixtures/nema17-thicker.script.json`). It records each invocation's argv, working directory, environment variable names and stdin size, so tests check the lockdown the app applied.

```bash
# Detection looks only in these folders (development and tests; ignored in packaged builds):
AICAD_CLI_DIRS=/path/to/folder-with-fake-claude pnpm --filter @aicad/desktop dev
```

**Isolated test profiles never touch your real CLIs.** When `AICAD_USER_DATA_DIR` is set (every e2e test does this), CLI detection is off unless `AICAD_CLI_DIRS` is set, and the default Ollama URL is not probed unless that profile's settings name one. A Settings path override is used only when it lies inside `AICAD_CLI_DIRS` (with no `AICAD_CLI_DIRS`, never), so a stored or seeded path to your real `~/.local/bin/claude` cannot run either. So no test can spend your plan by accident, whatever is installed on the machine.

**Test profiles run `Automatic` as single calls.** With `AICAD_USER_DATA_DIR`, the CLI mode `auto` means completion mode unless `AICAD_CLI_AUTO=runtime` is set (a stored `runtime` or `completion` setting is always honored). The fake above only answers single calls; a test that wants the agent runtime says so. `e2e/runtime.e2e.ts` does, with the agent package's MCP-speaking fake (`packages/agent/test/fake-cli/fake-claude.mjs`).

## Tests

```bash
pnpm --filter @aicad/app test        # proposal diff / variants / dependency warnings, agent service + commands
pnpm --filter @aicad/desktop test    # protocol validation, key store, settings, host (fake worker), runner (scripted, real forge-web),
                                     # CLI providers with the fake Claude Code (detection, precheck, keyless run, tripwire,
                                     # persisted blocks, Stop, used-up plan) and agent-runtime mode (test/cli-runtime.test.ts)
pnpm --filter @aicad/agent test      # + cancellation (AbortSignal) and onDraft
pnpm --filter @aicad/desktop test:e2e
```

- **`e2e/agent.e2e.ts`** runs offline with the scripted transport and `--use-mock-keychain`. It covers:
  - the run: progress checklist, cost meter, question card, proposal diff, preview toggle, accept (document and viewport update), undo;
  - Stop while the agent waits for an answer;
  - the key store: encrypted at rest, never visible to the renderer, removable.

  It also saves `docs/spikes/assets/agent-proposal.png`.
- **`e2e/providers.e2e.ts`** runs keyless and offline with the fake Claude Code (`AICAD_CLI_DIRS`): Settings (Claude Code ready with a Max plan, the other CLIs not installed, keys optional, "Using Claude Code (detected)", disabled pickers with reasons), a full run with plan usage and the proposal, and a logged-out CLI refused with the login command and picked up by Re-check. It saves `test-results/providers-settings.png`, `providers-run.png` and `providers-login-needed.png`.
- **`e2e/runtime.e2e.ts`** runs keyless and offline in agent-runtime mode, with the agent package's fake `claude` that speaks MCP and a deliberately long profile folder (the socket falls back to a shorter private root): BUILD runs in the CLI's own loop, the question card comes from an MCP `ask_user` call, and the proposal from MCP `apply_cadscript` + `propose`; then a lockdown violation inside a runtime phase blocks Claude Code, across an app restart, until Re-check. It saves `test-results/runtime-run.png`.
- **`e2e/cli-quit-cleanup.e2e.ts`** runs keyless and offline with fake `claude` binaries: a used-up plan shows the reset of the 5-hour window that ran out (not the 7-day window's, days later) in the run card and in Settings; quitting the app while a runtime phase is inside Claude Code's own loop kills the CLI and its MCP server and leaves no workspace or socket folder behind.
- **`test/cli-runtime.test.ts`** drives the worker's runner in runtime mode with the real `@aicad/agent/cli-runtime` and the workspace's `@aicad/mcp-server` (real broker and shim): the full run with plan usage and the CLI children's environment, a lockdown violation reported for blocking, and Stop during a phase (processes and workspace gone).
- **`e2e/agent-live.e2e.ts`** is a real model run. It costs money, so it is skipped unless both `AICAD_LIVE_E2E=1` and a provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`) are set.
- **`test/cli-live.test.ts`** checks the real Claude Code on your machine, only with `AICAD_LIVE_CLI=claude`: detection, lockdown and login (no model call). `AICAD_LIVE_CLI_RUN=1` adds one keyless run with Haiku in every role, at most 4 CLI invocations; `AICAD_LIVE_CLI_RUNTIME=1` adds the same task in agent-runtime mode (BUILD in Claude Code's own loop over our MCP tools; a guard stops it after 12 model turns). Never in CI.

## Changes to shared packages (additive)

- **`@aicad/agent`:**
  - `AgentOptions.signal` (an AbortSignal). It is checked before every model and tool call and passed to provider requests.
  - The new stop reason `cancelled`.
  - The `AgentHooks.onDraft` hook, called after every apply and rollback.
  - The exported `AgentDraft` and `throwIfCancelled`.
  - New tests in `test/agent.test.ts`.
- **`@aicad/llm-gateway`, `@aicad/agent-tools`, `@aicad/forge-web`:** no changes.
- **Providers (ADR 0014, this app):** the IPC types gained provider kinds, billing, CLI and local statuses, plan usage, the start codes above and `settings:probeProviders` (all additive, `packages/app/src/agent-protocol.ts`). The desktop uses the gateway's `@aicad/llm-gateway/cli` (detection, lockdown, transports), `@aicad/agent/cli-runtime` and, when present, `@aicad/mcp-server`; it changes none of them.

### Differences from the frozen interfaces (for docs/CLI-PROVIDERS.md §16)

The desktop and app workstream does not own docs/CLI-PROVIDERS.md. These are the shapes the code actually has; the doc owner should record them in §16 (or amend §11.4 and §5.3):

- **§11.4 `AgentSettingsView`:** `cli`, `local` and `cliMode` are optional (a scripted or replay build has no provider detection); added `autoDefault: { provider, label } | null` (the provider the defaults come from) and `ollamaBaseUrl: string | null`.
- **§11.4 `ModelProfileInfo`:** added `reason?: string` (why an unavailable profile is disabled in the pickers).
- **§11.4 `AgentRunResult`:** added `quota?: { kind: "quota_exhausted" | "rate_limited"; provider: string | null; resetsAt: string | null }` (a run stopped on a plan or rate limit, with the reset time from the CLI's plan report).
- **§11.1 worker protocol:** `WorkerToHost` gained `{ type: "cli", kind: "lockdown_violation", provider, realPath, detail }` (block that binary) and `{ type: "procs", pids }` (process groups to kill if the worker dies); `WorkerCliConfig` gained `exePath`, `mcpServerDir` and `childEnv` (CLI login locations and proxy/CA settings for CLI children only).
- **§5.3 "Desktop":** the worker is forked with the plain allowlist, `agentWorkerEnv(env)`, not `agentWorkerEnv(env, [...CLI_ENV_LOCATION, ...CLI_ENV_NETWORK])`; those variables reach CLI children through `WorkerCliConfig.childEnv`. Trade-off: the CLIs still get `NODE_EXTRA_CA_CERTS` and proxies from the app's environment (they need them behind corporate proxies); the process that holds API keys does not.
- **§5.4 location:** the desktop uses `<userData>/cli-work` only when every folder above it is private and `<root>/s/<8 hex>/b.sock` fits 103 bytes; otherwise a per-profile folder (`app-<hash>`) in the gateway's private default root; with neither, a too-long data folder turns the broker off (single calls) with a note, and a data folder under a shared folder turns CLI providers off with a note.
- **§5.8 cleanup on quit:** the gateway has no call to dispose the live workspaces of a process that is being killed, so the desktop relies on its root being exclusive to the app instance and empties it on `will-quit` (after killing the worker and the CLI process groups) and at start. Gateway and agent owners: `quotaFailure` (`llm-gateway/src/cli/claude.ts`) and the runtime's quota failure (`agent/src/cli-runtime.ts`) still take the latest reset among the windows, and `PlanUsage` drops the top-level `resetsAt` / `rateLimitType` when `unifiedWindows` is present; the desktop picks the used-up window by utilization.
- **§5.5 Re-check:** a block is persisted (`agent-settings.json` `cliBlocks`) and keyed by real path + size + mtime; a passing forced Re-check or a changed binary lifts it.
- **§11.2 test profiles:** `AICAD_CLI_DIRS` restricts detection to those folders (no PATH, install dirs or login shell), and a Settings path outside them is not used; an isolated profile (`AICAD_USER_DATA_DIR`) without it detects no CLI; with an isolated profile, `auto` means completion unless `AICAD_CLI_AUTO=runtime`. All ignored in packaged builds.

## Planned: approved North Star changes

The owner approved [NORTH-STAR.md](NORTH-STAR.md) on 2026-09-24. The items below change how you work with the agent and by hand. **None of them is built.** Each names its phase and its NORTH-STAR §8 row. Phase 1 alpha means the alpha builds (closed ~M7, Apr 2027; open ~M8, May 2027). Phase 1 beta is ~M10 (Jul 2027), the Phase 1 exit. Numbers are provisional. Each item gates only itself; none joins the F2 gate.

| Item | In one line | Status | Source |
|---|---|---|---|
| [Autonomy dial](#the-autonomy-dial) | You choose how agent work lands: per step, per feature, or auto-apply for checked quick edits to the agent's own features | Planned, Phase 1 beta | B5; [ADR 0015](adr/0015-autonomy-dial.md) |
| [Checkpoints](#checkpoints-and-the-ghost-overlay) | A named, restorable snapshot before every commit of agent work | Planned, Phase 1 alpha | B4; ADR 0015 §7 |
| [Ghost overlay](#checkpoints-and-the-ghost-overlay) | The proposal drawn translucent over your model | Planned, Phase 1 alpha | B4 |
| [⌘K on the canvas](#k-on-the-canvas) | A quick edit at the selection, shown in place as a checked ghost | Planned, Phase 1 alpha | B3 |
| [Tab](#tab) | A checked ghost of the likely next feature, from 5 deterministic proposers | Planned, Phase 1 beta; off by default until its gate is met | B3 |
| [Push/pull and dimension drag](#pushpull-and-dimension-drag) | Dragging a face or a dimension edits the parameter behind it, with a feasible clamp and a provisional preview | Planned, Phase 1 alpha | B1 |
| [Engineering copilot tools](#engineering-copilot-tools) | A sourced handbook and 8 calculation tools, each returning formula, inputs and source | Planned, Phase 1, M3–M5 (Dec 2026–Feb 2027) | B6 |
| [Design context](#design-context-in-the-model) | Material, process, machine, loads and requirements stored in the model | Planned, IR v1.1, after Phase C | B7; [ADR 0018](adr/0018-design-context-in-the-ir.md) |

### Rules every surface keeps

- **Nothing unchecked is committed.** Forge builds and checks every proposal, ghost and drag result before you can accept it. Nothing is committed, accepted or exported that Forge has not built and checked. The one exception is on screen during a drag: live frames come from a fast preview path and are drawn in a provisional style.
- **One model.** A hand move becomes a parametric feature or a parameter edit. An agent move arrives as a diff. Both share one IR, one CadScript file and one undo stack, and both go through the command layer above.
- **The agent never silently touches your features.** This VISION non-goal holds at every dial setting and on every surface. ADR 0015 adds a check at commit that enforces it.
- **Every engineering number shows its formula, inputs and source,** and lives in the model as an editable value, not as chat text.

### The autonomy dial

**Planned, Phase 1 beta** (NORTH-STAR B5; [ADR 0015](adr/0015-autonomy-dial.md)). Today there is one setting: the per-feature review described above. "Autonomy" means this dial only.

| Setting | What happens |
|---|---|
| **Ask at each step** | The agent stops after every plan step. You accept or reject that step before it goes on. The whole task is still one undo step |
| **Propose per feature** (default) | Today's behavior. The agent builds the whole task on its draft, then you accept or reject each feature |
| **Auto-apply checked quick edits** | A checked quick edit that touches only agent-authored features lands without a click. A notice names what changed and offers **Undo**, **Review** and **Keep**, and the timeline shows an "agent" badge. Anything else is proposed per feature |

- **Only you set it.** The control sits in the Assistant panel header, which always shows the current value, and in Settings. It is stored per project in app settings, not in the IR. No agent tool, MCP scope, skill, file or CLI flag can set or raise it. A CLI's own permission or approval mode is part of ADR 0014's lockdown and never counts as your approval.
- **The app never raises it by itself.** After a clean record it may *offer* the next setting up, once, after a commit. Clean record (provisional): the last 20 agent tasks in the project committed with no rejected feature or step, no undo within 60 s and no known issues.
- **Authorship.** A feature counts as agent-authored until you accept it or edit it. From then on it is yours. The host's command layer records this in the feature's existing `author` field, and agents cannot write it. A file with no marks, which is every file today, reads as all yours. **Keep all** makes every agent-authored feature yours in one undoable op.
- **Auto-apply is narrow on purpose.** Every condition in ADR 0015 §5 must hold. Among them: triage routed the task to a quick edit (the `quick_edit` route exists today); it changes at most 3 features; the PROPOSE gate is clean; it changes only agent-authored features and no existing parameter; no user-authored feature depends on the change; the part is not marked safety-critical; you made no edit during the run. Exports are never auto-applied.
- **The commit check.** Every commit of agent work carries an approval record in the decision log. A change to a user-authored feature or parameter without your approval refuses the whole commit with `unapproved_user_change`, and the draft stays as a proposal. The check runs in the command layer, so the UI, the agent, the CLI and MCP all pass through it. It makes NORTH-STAR §7's gate measurable: 0 silent changes to user features.
- **What it does not change:** the verification ladder, the ask and stop rules, the budget and which model runs.
- **Runtime mode.** At Ask at each step, the per-step pause uses the broker's user-wait path, as `ask_user` does. A CLI that cannot hold a tool call open that long runs BUILD in completion mode for that task.
- **When Auto-apply appears.** Only in builds where the commit check and checkpoints are in place, the silent-change gate holds on MakerBench T4 and on the commit check's own tests, and checkpoint restore is 100% correct.

| Surface | How the dial applies |
|---|---|
| Always-on checks (no LLM) | They never edit. A check's Fix is always a proposal |
| Tab, ⌘K | Always a checked ghost that you accept. An accepted ghost is yours |
| Agent (this panel, any provider, completion or runtime mode) | Follows the dial |
| Background jobs (variants, part families, drawings) | Always land on their own branch. Merging is a per-feature review at every setting |
| External agents (MCP, CLI) | Never auto-apply. Always the `mcp/<client>` branch, reviewed in the same diff UI |

### Checkpoints and the ghost overlay

**Planned, Phase 1 alpha** (NORTH-STAR B4; checkpoints in [ADR 0015](adr/0015-autonomy-dial.md) §7). Today there is undo only, and the preview is a tinted toggle (see [Open issues](#open-issues)).

- **A checkpoint** is a named, restorable snapshot of the committed document: its IR, CadScript and authorship marks. Checkpoints are local and stay out of the IR.
  - The app takes one before every commit of agent work, from any surface and at any dial setting, and before every branch merge. You can take one by hand at any time.
  - Restore is one undoable transaction. It checkpoints the current state first, so restoring never loses work.
  - Gate: restore is 100% correct, meaning canonical IR equal to the snapshot and an identical regenerated report.
  - Retention of automatic checkpoints is a setting. Manual checkpoints are never pruned automatically.
  - They are separate from the agent's `checkpoint` and `rollback` tools, which act on the agent's draft only and never touch the document.
- **The ghost overlay** draws the proposal translucent over your model, instead of replacing its bodies, with badges in the timeline (ARCHITECTURE §7). It needs alpha blending for bodies in forge-render. ⌘K and Tab show their ghosts the same way.

### ⌘K on the canvas

**Planned, Phase 1 alpha** (NORTH-STAR B3).

- Select something in the viewport, press ⌘K and type a quick edit, for example "make this 2 mm thicker". The edit appears in place as a ghost, and only after Forge has built and checked it. You accept it, and it is then yours, or you dismiss it.
- It always proposes, whatever the dial says.
- It runs the same agent and the same verification ladder as the Assistant. The selection travels as the same semantic selection chips.
- **Today** the same request goes through the Assistant panel with selection chips, and triage routes it `quick_edit`. ⌘K (and ⌘⇧P) opens the command palette. How the two share the key is settled when on-canvas ⌘K is built.

### Tab

**Planned, Phase 1 beta, off by default until its gate is met** (NORTH-STAR B3).

- Tab shows a checked ghost of the likely next feature. **Tab** accepts it and **Esc** dismisses it. An accepted ghost is yours.
- **Five deterministic proposers:** no LLM, 300 ms or less. Tab calls no model, so it spends no plan usage. NORTH-STAR §2 names four examples; the fifth is chosen in Tab's design:
  - an extrude after a closed profile;
  - a pattern after a second identical hole;
  - "fillet 2 mm (max 3.41)" on picked edges, which needs F2's feasible ranges;
  - an M3 chip, "clearance 3.4 / insert 4.0 / tap 2.5", with sources from the `fastener` tool ([below](#engineering-copilot-tools)).
- **Gate:** ≤300 ms, ≥30% of offers accepted and ≤5% undone within 60 s, on ≥2,000 offers in the alpha study group. Tab stays off by default until all three are met.
- **Counts.** Tab offer, accept and undo counts join the opt-in allowlist of [ADR 0017](adr/0017-opt-in-product-counts-and-failure-reports.md) when Tab ships. They are counts, never design content.
- **A learned next-feature model is a bet.** Proof: a measurable lift over the deterministic proposers' accept rate. It needs licensed CAD sequences and consented accept logs. ADR 0017's counts are not training data; that needs a separate content consent. ARCHITECTURE §8 rules out fine-tuning before M13.

### Push/pull and dimension drag

**Planned, Phase 1 alpha** (NORTH-STAR B1). Today there is no sketcher UI and no on-canvas handle.

- **Drags drive parameters.** Pull a plate's top face and its `thickness` parameter changes. Drag a dimension and its value changes. When a parameter drives the face, no new feature is added. Typed dimensions also become parameters (Planned, Phase 1).
- **Feasible clamp.** A drag stops at the feasible limit and says why. For example, a fillet drag stops at "max 3.41 mm: the wall would vanish". Feasible ranges arrive with F2 (Phase C step W6). The F2 target: ≥90% of single-parameter out-of-range errors return a feasible interval.
- **Provisional preview.** Live frames come from a fast preview path and are drawn in a distinct provisional style. They are never committed. On release, Forge builds and checks the value. If that fails, the preview snaps back to the feasible limit.
- **Targets (NORTH-STAR §7):** a provisional frame in ≤16 ms p95; the checked result ≤150 ms after release; a sketch drag in ≤4 ms. Today an edit reaches the screen in 46.9 ms median on 25 features, about 20 fps ([spike 05](spikes/05-renderer.md)), and a 200-entity sketch drag takes 1.75 ms worst case ([spike 04](spikes/04-sketch-solver.md)).
- **A drag is your edit.** It is one undo step, and dragging an agent-authored feature makes it yours (ADR 0015). A drag during an agent run is an edit during the run (see [Open issues](#open-issues)).
- **Faces no parameter drives** fall back to local face operations ([ADR 0019](adr/0019-local-face-operations.md)), Planned at F3 (M8–M14). Faces of imported STEP parts follow once the IR `import` revision gives them stable keys (ADR 0019 §5).

### Engineering copilot tools

**Planned, Phase 1, M3–M5 (Dec 2026–Feb 2027)** (NORTH-STAR B6 and §3). ARCHITECTURE §6 names these tools; none is built. The agent's tools today are `get_code`, `apply_cadscript`, `ir_summary`, `measure`, `set_spec_tests`, `submit_spec`, `run_tests`, `checkpoint`, `rollback`, `ask_user` and `propose`.

- **A sourced handbook**, `reference(topic)`, and **8 calculation tools**: `fit` (ISO 286), `fastener`, `print_clearance`, `snap_fit`, `gear`, `bearing_select`, `beam_plate` and `material`.
- **Deterministic, no LLM.** Each returns its formula, inputs and source. The in-app agent, Tab's proposers, the UI and external agents (MCP) use the same tools.
- **Numbers land in the model** as editable parameters or chips on the feature, not as chat text. For example, "M3 heat-set insert?" gives "Ø4.0 × 6.7 mm deep (ruthex, CNC Kitchen; insert length + 1 mm)" as a chip on the boss.
- **Data rules.** Values are computed from formulas or cited facts, never copied tables (ISO tables are copyrighted). Each value has two sources, as the IR v1 hole table does (with its noted exceptions). Each source is recorded with its terms.
- **Gate:** 100% of ≥150 golden cases within 1% before the tools ship, and ≥300 by beta. These check the arithmetic, not whether a part holds.
- **Closed-form structural checks.** "Will this hold 5 kg?" gets a margin range plus its simplifications and assumptions. If no formula fits, or the part is printed and outside validated cases, the answer is "can't verify", never a guess. Printed-part safety-factor badges ship only after Fit Lab break tests. FEA and the Phase 5 advisor gate stay.
- **Wording.** The advisor explains; a human signs off. We never say "certified" or "safe", and safety-critical parts still need an explicit acknowledgment (ARCHITECTURE §6 stop rules).

### Design context in the model

**Planned, IR v1.1, after Phase C** (NORTH-STAR B7; [ADR 0018](adr/0018-design-context-in-the-ir.md)). Today these values have no home in the model: they live in chat, in display-only assumption chips and in the agent's run.

- **A typed `context` block**, per document and per part: a material (a handbook id, with sourced overrides), a process, a machine-profile snapshot, requirements (text, plus an optional check), loads, decisions and assumptions.
- **Geometry-free.** Nothing in evaluation reads it, and the oracle ignores it. Removing it leaves the metrics report bit-identical.
- **Checks read it, with no LLM call.** Editing a wall or a load reruns the checks locally. For example, a load badge "5 kg: SF 1.8–3.4 (PLA, printed flat, 20% infill)" turns red when you thin a wall. Each requirement shows met, unmet, can't verify (with the reason) or not checkable. Printed-part load checks say "can't verify" until the Fit Lab break tests for that material exist.
- **In the Assistant.** The SPEC step writes requirements, loads and assumptions into the context, and `log_decision` writes decisions. The spec card and assumption chips read it, so editing a chip needs no LLM call. "Why?" on a value resolves to a stored decision with its sources.
- **Edits follow the feature rules.** Context edits are domain ops with inverses through the command layer, so they undo, diff and merge. The agent proposes context entries on its draft. They follow the dial and stay agent-authored until you accept or edit them. External agents land on their `mcp/<client>` branch.
- **Machine profiles** live in the app's settings. Attaching one copies a snapshot into the design, so its checks reproduce on another computer. When the library profile changes, for example after a new fit coupon, the app offers an update. It never applies one silently.
- **Privacy.** Context is design content. It stays in your local file and is never part of ADR 0017's counts. During a run it goes to the model provider with the rest of the design, under that provider's terms (see **Data** under [Providers](#providers-cli-agents-local-models-and-optional-api-keys)). Every free-text context field is marked untrusted when a tool shows it to a model.

## Open issues

- **Packaging.** The agent worker resolves `@aicad/agent`, the gateway, forge-web (and its `.wasm`) and the agent's `prompts/` from the pnpm workspace. `electron-builder` needs a bundling step for `dist/agent/worker.js` and its assets, or `node-linker=hoisted`, before a packaged build can run the agent.
- **The document during a run.** The document stays editable during a run. The proposal rebases onto your edits at accept time, and it refuses on conflicts. The agent itself is not paused or rebased mid-run ("a user edit in the agent's scope pauses it"); that pause is Planned. At the dial's Auto-apply setting (Planned, Phase 1 beta), any edit of yours during a run turns that task into a proposal (ADR 0015).
- **Parameter chips.** Assumption chips display the agent's assumptions but are not editable yet. Editing a chip with no LLM call needs IR v1 parameters. Chips for material, process and machine also need the [design context](#design-context-in-the-model) of IR v1.1 (ADR 0018, Planned after Phase C).
- **L5 visual judge.** The judge is not called yet. The judge model setting is stored and validated (family rule).
- **The ghost preview.** The preview is a toggle: tinted proposal bodies replace the document's bodies. It is not a translucent overlay, because forge-render has no alpha blending for bodies yet. The [overlay](#checkpoints-and-the-ghost-overlay) is Planned for Phase 1 alpha (B4).
- **Continuing a budget checkpoint.** At the 80 % budget checkpoint, the run asks whether to continue up to the cap. Raising the cap mid-run is not supported.
- **Scripted mode and model settings.** The scripted and replay transports speak the Anthropic format only, so model settings are ignored in those modes.
- **CLI agents in packaged builds.** The desktop package does not depend on `@aicad/mcp-server` yet (the worker loads it from the workspace in development), and packaged builds turn Electron's `runAsNode` fuse off, so the MCP shim cannot run there. Claude Code single calls need neither; Gemini CLI and opencode then use the strict JSON reply, and runtime mode stays off (Automatic means single calls there), which resends the transcript on every designer turn: slower and costlier on the plan than the CLI's own loop. A packaged shim (a small bundled Node binary, or a helper executable) is the fix.
- **`providers.e2e.ts` relies on the test-profile rule** (`auto` runs as single calls in an isolated profile). Pinning `cliMode: "completion"` in its seeded settings would make that explicit; that file belongs to another workstream.
- **Codex CLI** is supported from its source and docs only (lockdown `static`, shown with a note); **Cursor Agent** stays blocked.
- **Background detection at start** runs each installed CLI's `--version`, `--help` and login probe; for opencode that includes `opencode mcp list`, which starts the user's own MCP servers briefly.

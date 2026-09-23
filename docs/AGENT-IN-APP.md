# The design agent in the desktop app

This doc covers how the Assistant panel runs `@aicad/agent` on the open document and hands back a reviewable **draft** (ARCHITECTURE §6–§7). It explains how to add API keys, where they are stored, and how to run the agent offline with the scripted transport.

![A proposal under review: the per-feature change list, the CadScript diff and the proposal preview in the viewport](spikes/assets/agent-proposal.png)

## Quick start

1. Run the app with `pnpm --filter @aicad/desktop dev`.
2. Open **Settings** (⌘, or the gear icon) and paste an API key for Anthropic, OpenAI or Google Gemini. You can also point the app at an OpenAI-compatible endpoint.
3. Optionally select a face or feature, then type a request in the Assistant, e.g. "make the plate 2 mm thicker".
4. Follow the progress checklist, the cost meter and any questions. Then review the **Proposal** tab: the diff, the per-feature checkboxes and the viewport preview.
5. Click **Accept** (or **Accept n of m**). The change lands as **one undo step**, and ⌘Z reverts it.

## Process layout

```
renderer (sandboxed React app)            main process                         agent utility process
──────────────────────────────            ────────────                         ─────────────────────
AgentService + commands  ── invoke ──▶    AgentHost                ─ post ─▶  AgentRunner
 agent.run / stop / answer  agent:start    · validates requests (v1)            · LLMGateway (keys in memory)
 settings.*                 agent:answer   · settings + key store               · @aicad/agent (interactive)
                            agent:stop     · resolves keys per run              · Engine: forge-web WASM in
                            settings:*     · forks / re-forks the worker          Node → Forge CLI fallback
ProposalView, RunCard  ◀── agent:event ──  forwards events            ◀ post ─  events (phase, tool, llm,
viewport preview                           (+ crash / stop-timeout)             cost, draft, question, result)
```

**Why a utility process** (`utilityProcess.fork`) rather than the main process:
- An agent run compiles and type-checks CadScript (the TypeScript compiler) and evaluates Forge WASM, synchronously, often for seconds at a time. In the main process that would stall IPC, menus and the `app://` protocol for every window.
- A crash, OOM or runaway loop in a provider SDK or in WASM would take the whole app down. Here it only ends the run. The main process reports `WORKER_EXITED` to the renderer and forks a fresh process for the next run.
- The process gets a **sanitized environment**: no `*_API_KEY`, `*_TOKEN` or `*SECRET` variables. It receives only the keys a run needs, in the `start` message.

The renderer stays sandboxed and CSP-locked (`connect-src 'self'`). It never talks to a provider.

**Engine.** The agent verifies every step (L0 compile → L1 kernel → L2 expectations → L3 tests) against `@aicad/forge-web`. That is the same WASM build the viewport uses, run in Node inside the utility process. If it is missing, the agent uses the native Forge CLI (`aicad`). With neither, the run stops with `engine_unavailable`.

## IPC protocol (version 1)

- **Where the types live:** `packages/app/src/agent-protocol.ts`, exported through `@aicad/app/bridge`.
- **Runtime validation:** `packages/desktop/src/agent/protocol.ts`.
- **Versioning:** every message carries `v: 1`. The main process rejects any other version, as well as unknown enums and oversize fields, and it drops unknown fields.

| Channel (renderer → main) | Request | Response |
|---|---|---|
| `agent:start` | `{ v, prompt, source, documentName, selection[{kind, ref, label, description}], process?, settings?{budgetUsd} }` | `{ ok: true, runId }` or `{ ok: false, code: NO_API_KEY \| BUSY \| INVALID_REQUEST \| UNAVAILABLE, message }` |
| `agent:answer` | `{ v, runId, questionId, answers[] }` | `{ ok }` |
| `agent:stop` | `{ v, runId }` | `{ ok }` |
| `settings:get` / `settings:update` / `settings:setApiKey` / `settings:clearApiKey` | see `SettingsUpdate`, `SetApiKeyRequest`, … | `AgentSettingsView` (never contains a key) |

`agent:event` (main → renderer) streams `AgentEvent`s. Each one carries `{ v, runId, seq, t }` plus one body:

| `type` | Meaning |
|---|---|
| `started` | Models per role, budget, transport (`live` \| `scripted` \| `replay`), engine |
| `phase` | Orchestrator state: TRIAGE, CLARIFY, SPEC, BUILD, REPAIR, REPLAN, PROPOSE, DONE, and its detail |
| `tool` / `llm` / `note` | Summarized tool calls, model calls with cost, orchestrator notes |
| `cost` | `spentUsd` and `budgetUsd` (the cost meter) |
| `draft` | A CadScript snapshot after every apply or rollback (the live "Draft" tab) |
| `question` / `answered` | Clarifying questions with options and defaults. The 80 % budget checkpoint arrives as `kind: "budget"` |
| `result` *(terminal)* | See below |
| `error` *(terminal)* | `WORKER_EXITED`, `STOP_TIMEOUT`, `RUN_FAILED`, … |

A `result` carries `status`, `stopReason`, `baseSource`, `proposedSource`, `changed`, `verified`, `summary`, `assumptions`, `knownIssues`, `answer?`, `tests?`, `costUsd`, `budgetUsd`, `latencyMs` and `turns`.

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

**Selection chips.** Selection chips are sent as semantic context, for example ``face `plate/cap:end` — the end cap (the face at the far end of the extrusion) of extrude `plate` of sketch `outline`, 5 mm``. The designer receives them in a `<selection>` block after the request.

**Review.** The proposal is diffed per feature (by part and feature name): added, modified or removed.
- **Dependency-aware rejection.** Rejecting a sketch that an accepted extrude uses is an **error** that names the fix. So is accepting the removal of a sketch that a kept feature still uses. Accepting a change without the sketch change it was made with is a **warning**.
- **Building the result.** The accepted subset is built on the IR and spliced into the CadScript with `applyIrEdit`, so untouched code and comments survive.
- **Edits during a run.** If you edited the document during the run, the accepted changes are rebased onto your edits, and any conflicts are reported.

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
- **Non-secret settings.** These live in `<userData>/agent-settings.json`: the model per role (designer, spec writer, triage, judge), the budget per task (default **$1.00**) and the OpenAI-compatible base URL.
  - When you change only the designer, the spec writer follows it and triage uses that provider's small model. A run then needs exactly one key.
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

## Tests

```bash
pnpm --filter @aicad/app test        # proposal diff / variants / dependency warnings, agent service + commands
pnpm --filter @aicad/desktop test    # protocol validation, key store, settings, host (fake worker), runner (scripted, real forge-web)
pnpm --filter @aicad/agent test      # + cancellation (AbortSignal) and onDraft
pnpm --filter @aicad/desktop test:e2e
```

- **`e2e/agent.e2e.ts`** runs offline with the scripted transport and `--use-mock-keychain`. It covers:
  - the run: progress checklist, cost meter, question card, proposal diff, preview toggle, accept (document and viewport update), undo;
  - Stop while the agent waits for an answer;
  - the key store: encrypted at rest, never visible to the renderer, removable.

  It also saves `docs/spikes/assets/agent-proposal.png`.
- **`e2e/agent-live.e2e.ts`** is a real model run. It costs money, so it is skipped unless both `AICAD_LIVE_E2E=1` and a provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`) are set.

## Changes to shared packages (additive)

- **`@aicad/agent`:**
  - `AgentOptions.signal` (an AbortSignal). It is checked before every model and tool call and passed to provider requests.
  - The new stop reason `cancelled`.
  - The `AgentHooks.onDraft` hook, called after every apply and rollback.
  - The exported `AgentDraft` and `throwIfCancelled`.
  - New tests in `test/agent.test.ts`.
- **`@aicad/llm-gateway`, `@aicad/agent-tools`, `@aicad/forge-web`:** no changes.

## Open issues

- **Packaging.** The agent worker resolves `@aicad/agent`, the gateway, forge-web (and its `.wasm`) and the agent's `prompts/` from the pnpm workspace. `electron-builder` needs a bundling step for `dist/agent/worker.js` and its assets, or `node-linker=hoisted`, before a packaged build can run the agent.
- **The document during a run.** The document stays editable during a run. The proposal rebases onto your edits at accept time, and it refuses on conflicts. The agent itself is not paused or rebased mid-run ("a user edit in the agent's scope pauses it").
- **Parameter chips.** Assumption chips display the agent's assumptions but are not editable yet. Editing a chip with no LLM call needs IR v1 parameters.
- **L5 visual judge.** The judge is not called yet. The judge model setting is stored and validated (family rule).
- **The ghost preview.** The preview is a toggle: tinted proposal bodies replace the document's bodies. It is not a translucent overlay, because forge-render has no alpha blending for bodies yet.
- **Continuing a budget checkpoint.** At the 80 % budget checkpoint, the run asks whether to continue up to the cap. Raising the cap mid-run is not supported.
- **Scripted mode and model settings.** The scripted and replay transports speak the Anthropic format only, so model settings are ignored in those modes.

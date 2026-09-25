# The live operator: the AI on the commands (AG stream, FM Part B)

- **Status:** built on branch `worktree-wf_c69c637e-016-8` (from `fm-integration` at `0d74c92`), 2026-09-25.
- **Plan:** [FULL-MODELING-PLAN.md](../FULL-MODELING-PLAN.md) §2.1 (one command layer), §2.2 (queries), §2.10 (what the agent gets), §5.5; the owner's binding feedback of 2026-09-25 ("the AI operates the tools, it does not primarily write code"; "the AI edits live").
- **Decision record:** [ADR 0022](../adr/0022-live-agent-edits.md) amends [ADR 0015](../adr/0015-autonomy-dial.md) for live edits.
- **Where:** `packages/agent/src/operator.ts`, `packages/agent/prompts/operator.v1.md`, `packages/agent-tools/src/ops-query.ts`, `ops-playbooks.ts`, `ops-reference.ts`, `packages/desktop/src/agent/{runner,host,protocol}.ts`, `packages/app/src/agent/{live-session,agent-service}.ts`, `packages/app/src/ui/ChatPanel.tsx`.

## What the user sees

On an IR v1 model (every new document), a request in the Assistant starts the **live operator**:

1. The plan appears in the chat as a short checklist.
2. Each change lands in the open model as it is made: the feature appears in the timeline (with the AI badge) and the viewport updates. The chat narrates it in one line ("Drill the Ø10 bore through the top"). A refused attempt shows as "Tried: …" with its code, and the agent repairs it.
3. When it finishes: the summary, the assumptions (standard sizes it chose), known issues, and **Keep** / **Undo turn**. The whole turn is **one undo step**.
4. **Stop** at any moment keeps everything built so far (still one undo step).
5. The **autonomy dial** in the Assistant header: *Ask each step* (the run waits after every step: Keep or Undo step), *Review turn* (default: works live, you keep or undo the turn at the end), *Auto* (works live, a notice). At every setting your own features and parameters change only with your approval: the agent asks ("The agent asks to change your work", Allow for this task / Don't allow).

No code appears anywhere in this flow. The CadScript proposal path is the fallback (`agent.setSurface { surface: "code" }`, or a document that is not an IR v1 model).

## How it works

```
renderer (app)                          main process                 agent utility process
─────────────                           ────────────                 ─────────────────────
AgentService.start ─ ir.openGroup (as agent) ─┐
  bridge.start {surface:"ops"} ───────────────┼─ agent:start ─────▶  AgentRunner → Agent({ ops: RemoteOpsHost })
LiveSession ◀── agent:ops {apply|document|    │                        OperatorRun (operator.ts)
  hostState|undo} ◀── only the run's window ──┼── worker "ops" ◀──    · op tools (agent-tools) on RemoteOpsHost
  appOpsHost → ir.apply (source agent,        │                        · reports / queries on its own Forge WASM
  group token) → IrDocStore → viewport,       │                        · hooks → step / outline / question events
  timeline                                    │
  ──▶ agent:opsReply ─────────────────────────┼─ worker "opsReply" ─▶ resolves the op call
AgentService ◀── agent:event {step, outline, question, result} ◀── the run's events
  result/error → LiveSession.close(): sealGroup (one undo step), abortGroup after a lockdown violation
```

- **One command layer.** Every change the agent makes is `ir.apply` from source `agent` through the app's command registry (`appOpsHost`): the same transactions, failure rule, commit check and authorship as any other caller. The agent process never touches the document; it only asks the renderer to apply catalogue ops and reads the canonical text back.
- **One undo group per turn.** `LiveSession` opens `ir.openGroup` as the agent before `agent:start` and seals it on the terminal event (result or error, Stop included). Your edits during the run are refused (`IR_GROUP_OPEN`), ops of other runs or after the turn are refused (`IR_GROUP_CLOSED`), and a document opened over the turn stops the run.
- **Approvals.** The agent's `request_approval` becomes a question of kind `approval`. When you answer Allow, the renderer records it on the store for that group only (`IrDocStore.approveForGroup`, host code, not a command) before the agent hears the answer; `agent.answer`, `agent.keep`, `agent.undoTurn`, `agent.setSurface` and `settings.setAutonomy` refuse agent and MCP callers. Headless hosts use `MemoryOpsHost.grant`.
- **The dial** is a stored setting (`agent-settings.json` `autonomy`, default `review`); the main process passes it to the worker from Settings, never from the request.

## The agent's tools

Generated from the op catalogue (`@aicad/model-ops`) plus:

| Tool | What it does |
|---|---|
| `find_entities` | Resolves a Ref or query (SPEC-v1 §5.3) on the live document at any point of the timeline: count, names, probes, whether its card fits. Scratch copy with `tag` features; nothing is stored. |
| `list_entities` | Faces, edges, vertices or bodies (of a feature, near a point, by name), each with a **named query synthesized from its provenance key** (cap, side, edge_at, between, hole_face, body) that the engine verified picks exactly that entity. |
| `measure`, `check_model` | Forge's measurements and verification (statuses, warnings, body validity, size, volume). |
| `plan`, `ask_user`, `request_approval`, `finish` | The operator's own (operator.ts). `finish` is refused once while a feature fails. |

Every model-changing tool takes a `note` (the narration) and returns **Forge's check of the whole model** after the change (`Check: ✓ 4 features ok · 1 body valid, 40×40×40 mm, V 60721.1 mm³`). Refusals carry op-worded hints (`ops-playbooks.ts`: every `COMMAND_*` and `IR_*` code, the common IR codes, feasible values from `details`), never CadScript. The system prompt carries the feature reference (`ops-reference.ts`) whose worked recipes a test runs on the engine.

`write_back_solution`, `upgrade_feature` and `set_rollback` are not offered to the operator (automatic, confirm-gated, the user's). Excluded from every agent: `setAuthor`, `replaceDocument` (host-only).

## Stop rules and limits

Stop (keeps the steps), a 10-minute wall clock by default (`OPERATOR_WALL_MS`), the 80 % budget checkpoint, 40 turns, the same refusal three times in a row (a note at two), 10 refusals per task (6 in CLI runtime mode), no progress. A CLI that breaks its lockdown ends the run and the turn is aborted.

## Tests

| Where | What |
|---|---|
| `agent-tools/test/ops-query.test.ts` (14) | find/list entities, named queries from keys, measure/check, the step check and narration, refusal hints with feasible values, playbook coverage, JSON-text leniency |
| `agent-tools/test/ops-reference.test.ts` (6) | every recipe of the reference builds call by call on the engine |
| `agent/test/operator.test.ts` (11) | the cube built step by step with scripted models on the real engine; Stop keeps; refusal repaired from its hint; same-error stop; Ask at each step undo; approval (granted / headless declined); wall clock; read-only question; finish gate; runtime mode through the fake runtime |
| `agent/test/cli-runtime.test.ts` (+1) | the ops phase through a fake Claude Code, the real MCP broker and shim |
| `desktop/test/agent-live.test.ts` (5) | protocol, the main process relay, the scripted cube run over the ops channel, Ask at each step undo through the channel |
| `app/test/agent-live.test.ts` (6) | the live session on the real engine: ops land as the agent in one group, your edits wait, Stop keeps, Keep, Undo turn, approvals scoped to the turn, agent can't answer, lockdown discards, a load stops the run |
| `desktop/e2e/agent-operator.e2e.ts` (3) | Electron, scripted: the cube lands step by step (checked mid-run), one undo step, Keep; Stop keeps; Ask each step |
| `desktop/e2e/agent-operator-live.e2e.ts` | gated (`AICAD_LIVE_CLI_E2E=1`): a real Claude Code run with a timestamped timeline |

## Live Claude Code runs (2026-09-25, Claude Code 2.1.260, Opus, agent-runtime mode, the owner's plan)

| Run | Prompt | Wall time | Steps | Result | Plan usage |
|---|---|---|---|---|---|
| 1 | a 40 mm cube with a 10 mm hole through the top and 2 mm fillets on the vertical edges | 23.2 s | 4 (1 refused call before them: `feature_json` inside `apply_ops`, now accepted) | 4 features ok, one valid 40×40×40 body, V 60 721 mm³ | ≈ $0.36 notional; the plan read 5-hour 37 %, 7-day 83 % after it |
| 2 | a 60 × 40 × 6 mm mounting plate with 3 mm rounded corners, four M3 countersunk screw holes 6 mm in from each corner, and a Ø20 boss in the middle, 10 mm tall, with an M5 heat-set insert hole in its top | 41.6 s | 7 (1 refused, `HOLE_OPTIONS_CONFLICT`, repaired from its hint) | 6 features ok, one valid 60×40×16 body; parametric; ISO 10642 countersinks; M5 insert preset | ≈ $0.28 notional; 5-hour 39 %, 7-day 84 % after it |

In both runs the features appeared in the timeline one by one while the run was going. The harness polls the chat and the model every 0.4 s; times are from pressing Enter (its JSON and screenshots go to the git-ignored `packages/desktop/test-results/`, which the next e2e run clears, so they are copied here):

| Run 1 | | Run 2 | |
|---|---|---|---|
| 3.5 s | plan shown (6 steps) | 7.8 s | step: add plate, corner, hole and boss parameters |
| 9.8 s | `base` sketch in the model | 10.7 s | `plate_sk` sketch |
| 11.9 s | `cube` extrude (40×40×40, V 64 000) | 12.7 s | `plate` extrude (60×40×6) |
| 14.6 s | `rounds` fillet | 15.5 s | `boss_sk` on the plate top |
| 17.0 s | `bore` hole (V 60 721.1) | 17.9 s | `boss` joined (60×40×16) |
| 17.7 s | check_model ✓ | 23.2 s | `mounts`: 4 × M3 countersunk |
| 20.9 s | finish accepted | 28.2 s | refused: insert hole with a depth (`HOLE_OPTIONS_CONFLICT`: an insert sets its own) |
| 23.2 s | run ended (9 turns, 8 tool calls) | 31.0 s | `insert_hole` M5 insert, repaired |
| | | 39.1 s | finish accepted; 41.6 s run ended (13 turns, 12 tool calls) |

The notional cost is the API list price Claude Code reports; the subscription is not billed per token. The plan percentages are the owner's windows as Claude Code reported them after each run (they include all other use of the plan).

## Not built / open

- **Spec-writer tests (L3) are not run in the live loop.** Verification is Forge's check after every step and at finish, plus the agent's own measurements. An independent spec writer would add a model call before the first step.
- **No triage call** in the live loop: a question is answered when the agent calls `finish` without changing anything (or with `kind: "ask"`, read-only).
- **Selection is sent as text chips** (as before); `refFor` from a picked face is not built, so the agent aims references itself with `find_entities` / `list_entities`.
- **No checkpoints and no per-feature review of a turn** (ADR 0015 §7; the turn is kept or undone as a whole; features can still be deleted or kept one by one from the timeline).
- **MCP:** the new reading tools are in the `ops` / `ext-ops` / `ops-read` scopes, but external MCP clients still cannot reach the app's live document (no IPC bridge to `appOpsHost`).
- **ADR 0015 §5.7** (a user feature must still build the same way after an agent change) is not checked; the failure rule catches only new failures.
- The dial is global (agent settings), not per project as ADR 0015 §1 says.

## Integrator notes

- `agent.setSurface { surface: "code" }` is set by the e2e suites that test provider, runtime and quit plumbing with code-scripting fakes (`agent`, `providers`, `runtime`, `cli-quit-cleanup`). Any other suite that starts an agent run on an IR v1 document now gets the live operator.
- New IPC channels: `agent:ops` (main → renderer) and `agent:opsReply` (renderer → main); worker messages `ops` / `opsReply`. All additive in protocol v1.
- The ops catalogue drives the operator's tools: ops other streams add to `OP_CATALOGUE` (e.g. `sketchEdit`, `setRef`) become operator tools automatically; `OPERATOR_EXCLUDED` in `operator.ts` is the only list to review.
- `ADR 0022` is a new number: renumber if another stream took it.
- The `@aicad/model-ops` dependency was added to `@aicad/agent` and (dev) `@aicad/desktop`; `pnpm-lock.yaml` changed accordingly.

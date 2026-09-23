# Spike 07: Agent vertical slice

- **Owner / workstream:** agent workstream (Claude Code), main working tree (no git in this workstream)
- **Dates:** 2026-09-23 → in progress (interim report: offline results only)
- **Commit(s):** uncommitted. New: `packages/agent-tools/`, `packages/agent/`. Additive changes in `@aicad/evals`: `testProblems()` and the `IrChange` type export.
- **Verdict:** PENDING. The slice works end to end offline. No provider key was available, so the live bake-off has not run and no GO/NO-GO criterion has been measured yet.

## Goal

The question: can our own agent loop build correct CadScript parts cheaply enough? The loop is the gateway, the tools, the verification ladder and the operation playbooks. The bake-off then decides which provider's flagship model should be the designer.

Criteria, verbatim from [README.md](README.md):

| Setup | GO when |
|---|---|
| About 12 tools; Anthropic, OpenAI and Google flagships; CadScript vs build123d-MCP on 30 T1 tasks. Early runs may evaluate CadScript through the `oracle/` backend. | <ul><li>CadScript ≥ build123d's score minus 5 points.</li><li>≥50% of hidden tests passing.</li><li>Median cost ≤$1.</li></ul> On a loss, change the syntax, not the engine. |

The README names the report `07-agent-bakeoff.md`. This report covers the vertical slice, the first half of the spike. The bake-off numbers will be added here once they exist.

**Scope of this iteration:**
- IR v0 only: sketches of lines, arcs and circles; extrude and revolve, each creating new bodies. Holes are inner loops of a sketch.
- The build123d-MCP comparison arm is not built. See the follow-ups.
- The L5 visual judge is a clearly marked hook, because `forge-render` does not exist yet.

## Setup

### `@aicad/agent-tools` (MPL-2.0)

**`DesignSession`**
- In-memory state: the CadScript source, its compiled IR, the latest report, the spec tests (with the DesignSpec) and checkpoints.
- Every mutation runs the verification ladder:
  - **L0:** `compile(source, { base: previous IR })` keeps feature ids stable. `typecheck(source)` runs too; a `tsc` error is kept only on lines without a CadScript error.
  - **L1:** `Engine.evaluate`, with per-feature status and an error code for each failure.
  - **L2:** the agent's own per-step `expect` checks: bodies, regions, holes, volume ±1 %, bbox ±0.05 mm.
  - **L3:** the frozen spec tests, evaluated with the `@aicad/evals` check DSL. Each result carries a **margin**: the slack left, or how far outside the tolerance it is.
- A level runs only when the level below passes.
- Every failure has an error signature, which the "same error twice" stop rule uses. Root causes sort before `DEPENDENCY_FAILED`.

**`ToolRegistry`**
- Tools are defined with zod and converted to **strict** JSON Schema:
  - every object is closed with `additionalProperties: false` and `required`;
  - no `$schema`;
  - keywords that Anthropic strict mode rejects (`minimum`, `minItems`, `pattern`, …) are restated in the description and still enforced by zod.
- Definitions are sorted by name and byte-stable.
- Inputs are validated before a handler runs. OpenAI strict-mode `null`s are mapped back to "absent".
- Unknown tools, unparseable arguments and exceptions become `isError` results with a way forward.
- Every result is clipped to about 2k tokens.

**Operation playbooks** (`repairHint`) cover every code:
- all `CS_*` codes and the IR-validation mirrors (`DIAGNOSTIC_CODES`);
- every kernel code in forge-ir `SPEC.md`;
- document rejections, engine plumbing (`ENGINE_*`, `FIXTURE_MISSING`) and engine-internal prefixes (`OCCT_*`, `FORGE_*`);
- `TS####`.

Hints are computed from the IR or source where possible:

| Code | Example of a computed hint |
|---|---|
| `SKETCH_OPEN_LOOP` | `'o_right'.end (45, 35) has no partner; the nearest curve end is 'o_top'.start (45, 36), 1 mm away (also unmatched — these two are meant to meet). Make them identical, e.g. set 'o_top'.start to [45, 35] …` |
| `SKETCH_BRANCHING` | `'bottom'.start (-40, -25) coincides with 2 other ends ('left'.end, 'dup'.start); exactly one may meet it …` |
| `SKETCH_CURVES_CROSS` | `line 'right' (40, -25)→(40, 25) and circle 'h1' c=(38, 0) r=3 meet at (40, -2.236) … The circle's center is 2 mm from 'right' but its radius is 3 …` |
| `REVOLVE_CROSSES_AXIS` | `Axis = the line u = 0 in sketch 'profile' coordinates. The profile … lies mostly on the u > 0 side (up to 5 mm) but 'bottom' (reaches (-2.65, 0), 2.65 mm across), … cross to the u < 0 side …` |
| `INCONSISTENT_ARC` | `|start−center| = 10 but |end−center| = 11. Keep start and center (r = 10) and set end to [0, 10] …` |
| `DEPENDENCY_FAILED` | `'slab' consumes sketch 'base', which failed with SKETCH_OPEN_LOOP. Fix 'base' …; 'slab' recovers automatically.` |

**Tools (v0).** Eleven tools here, plus the triage `classify` tool in `@aicad/agent`, make twelve. Each role gets a sorted subset.

| Tool | Role | What it does |
|---|---|---|
| `get_code` | designer | The whole file, or one feature's `const` statement with its comments and line numbers |
| `apply_cadscript` | designer | Replace the file (`source`) **or** patch features by const name: replace, delete (empty code) or insert (`after`). Optional `expect` for L2. Returns a short delta: changes, L0 diagnostics with excerpt and fix, L1 per-feature status with playbook fix, bodies of *changed* features, model totals, L2, L3 with margins, next step. |
| `ir_summary` | designer | Compact feature list with key parameters and per-feature results (≤ 4k tokens) |
| `measure` | designer | Model totals, or one feature in detail: volume, area, centroid, bbox, face/edge counts by type; regions, loops, holes, outer curves |
| `run_tests` | designer | Frozen spec tests with margins |
| `checkpoint` / `rollback` | designer | Named states. A checkpoint is also taken automatically after every successful apply. |
| `ask_user` | designer | ≤ 3 questions, each with a default. Eval mode answers from the task's recorded defaults, or "use your best judgement". |
| `propose` | designer | Ends the task: summary, assumptions, known issues |
| `set_spec_tests` / `submit_spec` | spec writer | Tests in the evals check DSL, validated with the new `testProblems()`; then the DesignSpec. Submitting freezes the tests. |

### `@aicad/agent` (MPL-2.0)

**Orchestrator.** A deterministic TypeScript state machine over `@aicad/llm-gateway`. It does not use the Claude Agent SDK.

```
TRIAGE ─┬─ ask ──────► ASK (read-only tools) ──────────────────────────────────────► DONE
        ├─ quick_edit ──────────────────────► BUILD ⇄ REPAIR ×2 → ROLLBACK+REPLAN ×1 → PROPOSE
        └─ design ─► CLARIFY? ─► SPEC (fresh) ─► BUILD ⇄ REPAIR ×2 → ROLLBACK+REPLAN ×1 → PROPOSE
stop rules (checked on every transition): same error twice · repairs+replan exhausted · 80 % budget ·
40 designer turns · refusal (never retried) · no progress
```

- **TRIAGE:** a cheap model with one strict `classify` tool. The kinds are ask, quick_edit and design; it also returns a complexity (T1–T3) and whether to clarify. On failure it falls back safely.
- **CLARIFY:** at most one round of at most 3 questions, only when triage asks for it. The designer model asks in its own short conversation, which shares the cached prefix. In eval mode the answers come from the task's recorded defaults (`clarify.assumptions`).
- **SPEC:**
  - The spec writer runs in a **fresh conversation**. It sees only the request, the process, the clarification answers and, for edits, a summary of the starting model.
  - It produces a DesignSpec (requirements with ids, assumptions with defaults, key dimensions) and 4–10 tests.
  - The tests are frozen before BUILD.
- **BUILD:**
  - A failing apply gets REPAIR 1/2 and 2/2 orchestrator notes. A third consecutive failure rolls back to the last verified checkpoint and adds a REPLAN note with the IR summary.
  - A failure after the replan's repairs stops the run with `repairs_exhausted`.
  - An identical error signature on two consecutive applies stops the run with `same_error`.
- **PROPOSE:**
  - An unverified model is refused once; after that, the best verified checkpoint is handed back.
  - Failing spec tests send the proposal back (REFINE ×2), unless the designer names them in `known_issues`.
  - An accepted proposal lists every remaining failing test as a known issue.
  - L5 `hooks.visualJudge` runs here when plugged in. It is off by default.
- **After a stop:** the result is the best verified state (most spec tests passing), with a synthesized proposal that names the stop reason.

**Context layout.** The order is chosen to keep the cached prefix stable:
1. **Tools,** sorted by name (about 5.9k chars for the designer).
2. **System prompt:**
   - the role prompt (`prompts/designer.v1.md`);
   - a CadScript reference **generated from `std/index.d.ts`** (about 10.4k chars): the package rules verbatim, every builtin with its signature, parameter docs and examples, every option type;
   - optional project conventions.

   A cache breakpoint follows the system prompt.
3. **Task header:** the request, process, starting model, clarifications, DesignSpec, frozen spec tests, budget and mode.
4. **Append-only turns** (`Conversation`, deep-frozen). Tool results are deltas. The IR summary is sent only at step boundaries (replan, rollback).

**Budget.**
- One gateway `Task` per run holds the USD cap (default $1.50, the T1 cap) and the ledger.
- Calls are projected with 6,000 output tokens; the per-role output ceilings are triage 1,024, spec writer 12,000 and designer 16,000.
- The run stops at 80 %. In interactive mode, a hook may continue to the hard cap.
- The result reports cost per role, tokens (including cache reads and writes), latency, turns, applies, repairs, replans, refines and the stop reason.

**Prompts**
- Versioned files: `prompts/designer.v1.md`, `prompts/spec_writer.v1.md` and `prompts/triage.v1.md`.
- A per-model-family variant `<role>.<version>.<variant>.md` is picked up automatically. The variant id comes from the gateway profile's `promptVariant` (`claude-5`, `gpt-6`, `gemini-3`, `generic`).
- Traces record each prompt's id and SHA-256 prefix.

**Models.** Defaults come from the gateway router: Haiku 4.5 for triage, and Opus 5.5 for the designer (medium effort) and the spec writer (high effort). `--designer-model X` sets the spec writer to X and triage to X's provider's small model. Each bake-off run therefore needs exactly one provider key.

**`LLMSolver`** implements the `@aicad/evals` `Solver`:
- It sees only the `PublicTask`.
- It returns the final CadScript, cost, latency and a transcript: triage, clarifications, spec, proposal, trace, events, and optionally the conversations.
- It keeps a per-task run record: status, stop reason, turns, applies, repairs and spec-test score.

**`runBakeOff`** runs the real pipeline (solver → compile → engine → hidden tests) once per designer model. It writes `<out>/<model>/{results.json,report.md,agent-runs.json}` and `<out>/comparison.{md,json}`. The comparison covers pass@1 overall and per tier, validity, hidden-test rate, median and total cost, p50 latency, median turns, proposals and stop reasons.

**CLI:** `aicad-agent run` and `aicad-agent bench` (see the commands below).
- `run --record <file>` saves every provider exchange.
- `run --replay <file>` replays them with no keys: offline trajectory replay for CI.

**Offline test harness**
- `ScriptedTransport` plays scripted turns as genuine Anthropic stream events. Every call goes through the real gateway (adapter, pricing, budget, ledger) and the real orchestrator.
- Calls are routed to the triage, spec-writer or designer script by the tools on offer.
- A scripted step can be a function of the call, e.g. "assert that the playbook hint arrived, then send the fix".

### Corpus, engines, dependencies

- **Tasks:** MakerBench (`corpus/makerbench`): 40 tasks, 25 of them T1.
- **Engine reports for offline tests:**
  - recorded with the OCCT oracle: `packages/agent-tools/test/fixtures/engine-reports.json` (9 scenarios) and `packages/agent/test/fixtures/engine-reports.json` (11 scenarios);
  - plus the existing evals MakerBench fixtures.
  - Re-record with `pnpm --filter @aicad/agent-tools fixtures` and `pnpm --filter @aicad/agent fixtures`.
- **Dependencies:** no new third-party runtime dependencies. The new packages use `zod` (MIT) and `typescript` (Apache-2.0), both already in the workspace, plus the workspace packages. `ajv` (MIT) is a dev dependency of agent-tools for schema tests.
- **Hardware:** Apple M4 Pro, macOS 27.0, Node 22.16, uv 0.8.17, OCCT 7.9.3 / build123d 0.12.0.

### Commands

```bash
pnpm install
pnpm -r --filter '!@aicad/app' --filter '!@aicad/desktop' build
pnpm -r --filter '!@aicad/app' --filter '!@aicad/desktop' test

# the scripted MakerBench integration also against the real OCCT oracle (≈10 s)
AICAD_EVALS_REAL_ENGINE=oracle pnpm --filter @aicad/agent test makerbench
```

`@aicad/app` and `@aicad/desktop` are excluded because another workstream is creating them in the same tree. At the time of writing, `packages/app` has no `tsconfig.json`, so an unfiltered `pnpm -r build` fails there.

**Live runs (once keys exist).** Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`. Each designer model needs only its own provider's key.

```bash
pnpm -r --filter '!@aicad/app' --filter '!@aicad/desktop' build

# 1. Smoke: one real T1 task per provider that has a key, $1 budget, real OCCT oracle.
#    Writes artifacts/live/<model>/<task>.json (with conversations). ~$0.3–1 per provider.
ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GEMINI_API_KEY=… pnpm --filter @aicad/agent test:live
#    options: LIVE_TASK=t1-m5-spacer LIVE_ANTHROPIC_DESIGNER=claude-sonnet-5 LIVE_OPENAI_DESIGNER=… LIVE_GOOGLE_DESIGNER=…

# 2. One interactive run, with a trace and a recorded trajectory for offline replay.
ANTHROPIC_API_KEY=… node packages/agent/dist/cli.js run --engine oracle --designer-model claude-opus-5-5 \
  --prompt "Can you make me a washer for M3 screws? 3.2 mm hole, 7 mm outside diameter, 1 mm thick." \
  --trace artifacts/agent/washer.trace.json --record artifacts/agent/washer.trajectory.json
node packages/agent/dist/cli.js run --engine oracle --prompt "…same prompt…" --replay artifacts/agent/washer.trajectory.json

# 3. The bake-off: the 25 T1 tasks, three flagships, the oracle engine, a $1.50 cap per task.
#    Worst case 25 × 3 × $1.50 ≈ $112; the per-task median target is ≤ $1.
ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GEMINI_API_KEY=… node packages/agent/dist/cli.js bench \
  --tasks corpus/makerbench --tier T1 \
  --models claude-opus-5-5,gpt-6-astra,gemini-3.1-pro-preview \
  --engine oracle --budget 1.5 --concurrency 4 --out artifacts/bench/2026-09-t1-flagships
#    → artifacts/bench/2026-09-t1-flagships/comparison.md (+ per-model results.json / report.md / agent-runs.json)

# 4. Full MakerBench (all tiers) for the chosen designer:
ANTHROPIC_API_KEY=… node packages/agent/dist/cli.js bench --tasks corpus/makerbench \
  --models claude-opus-5-5 --engine oracle --out artifacts/bench/2026-09-all-opus
```

## Results

The only model used offline is the scripted one, so these results show that the harness and the orchestration are correct, not how good any model is.

| Criterion | Target | Measured | Pass? |
|---|---|---|---|
| About 12 tools | ~12 | 12 (11 design tools + `classify`); strict, sorted, byte-stable schemas accepted by all three provider rewrites | Yes |
| Anthropic, OpenAI, Google flagships | bake-off ran | Harness ready (`aicad-agent bench`, gated live tests). **Not run: no keys.** | Pending |
| CadScript vs build123d-MCP on 30 T1 tasks | ≥ build123d − 5 pts | build123d-MCP arm not built; MakerBench has 25 T1 tasks | Pending |
| ≥ 50 % of hidden tests passing | ≥ 50 % | not measured (live) | Pending |
| Median cost ≤ $1 | ≤ $1 | not measured (live). Estimate below. | Pending |
| Scripted agent through the real MakerBench pipeline | 3/3 | **3/3 T1 tasks pass** (washer, M5 spacer, rect gasket), validity 100 %, all hidden tests. Two of the three designers make a mistake first (open loop, profile across the revolve axis) and fix it from the playbook hint. The same result against the **real OCCT oracle**. | Yes |
| Mistake → hint → fix → spec tests → propose | works | Gasket: `SKETCH_OPEN_LOOP` → computed hint → 1 patch → 5/5 spec tests → proposal. States `TRIAGE → SPEC → BUILD → REPAIR → BUILD → PROPOSE → DONE`. | Yes |
| Stop rules | tested | same error twice; REPAIR ×2 → ROLLBACK+REPLAN → success; replan fails → `repairs_exhausted` (best verified state returned); 80 % budget soft stop; hard cap refuses unsent calls; refusal not retried; no progress | Yes |
| Spec-writer isolation | never sees builder messages | Tested: the spec writer's requests hold no designer system prompt, no designer tools, no designer text (including the CLARIFY turn), and start with one fresh user message. They do contain the request and the clarification answers. | Yes |
| Cached prefix | stable | tools + system byte-identical across every designer call and across the CLARIFY and BUILD conversations; identical first request across runs | Yes |
| Cost accounting | exact | `result.costUsd` = gateway ledger sum = trace sum; per role, from profile pricing | Yes |
| Unit/integration tests | green | agent-tools **51** passed (+1 opt-in recorder); agent **31** passed (+1 recorder, +3 live, all opt-in); evals 280 (+3 new for `testProblems`) | Yes |

**Estimated cost for a T1 task on Opus 5.5.** This is an estimate, not a measurement.
- The designer's cached prefix is about 20k chars (about 6k tokens).
- A typical run has about 2 spec-writer turns and 4–6 designer turns of 1.5–3k output tokens each, cache reads after the first turn, plus a triage call of well under $0.01.
- That puts the median at roughly **$0.3–0.6**, inside the $1 target. The live runs will replace this estimate.

**Found while building**
- The error signatures were sorted alphabetically, which put `DEPENDENCY_FAILED` before its root cause. The "same error" stop message then named the symptom. Root causes now sort first, both in the signature and in the tool result.
- zod's `.int()` emits the safe-integer range as `minimum`/`maximum`, and Anthropic strict mode rejects both keywords. The registry now drops that range and restates real constraints in the description (zod still enforces them).
- The oracle reports the *first* failing end in SPEC §3.1 order. The playbook uses the same order, so the hint and the engine message always name the same curve end.

## Verdict: PENDING

The vertical slice is complete and works offline:
- tools, playbooks, the ladder, the state machine with its repair, replan and stop rules, spec-writer isolation, the stable cached prefix, budget accounting, the MakerBench solver and the bake-off CLI;
- the scripted run gives the same result against the real OCCT oracle.

Confidence in the *plumbing* is high: 82 new tests, plus the real oracle.

**None of the three GO criteria has been measured.** They need live model runs, and the build123d-MCP comparison arm does not exist yet. The verdict will be set after the bake-off (commands above).

## Follow-ups

- [ ] Run the live smoke tests, then the T1 bake-off (commands above). Record the results here, with the commit and hardware.
- [ ] Build the build123d-MCP comparison arm: the same tasks, an MCP server over `oracle/` with build123d, driven by the same models. Or amend the criterion in this report if we decide against it.
- [ ] Bring T1 to 30 tasks (it has 25), the size the README criterion names.
- [ ] Tune the prompts from live transcripts. Add per-provider variants (`designer.v1.gpt-6.md`, `designer.v1.gemini-3.md`) only where transcripts show a need.
- [ ] Budget projection uses 6,000 output tokens, not the worst case (16,000 for the designer), so one call can overshoot the cap by up to about $0.20 on Opus 5.5. Decide whether to project the worst case (fewer turns fit in $1) or keep the soft 80 % stop.
- [ ] The interactive "continue for ~$X?" at 80 % is only a hook. A continuation needs a new gateway Task, because the cap is immutable.
- [ ] L5 visual judge: implement `hooks.visualJudge` once `forge-render` exists (a different model family from the designer, per ADR 0009).
- [ ] Tools from ARCHITECTURE §6 not in v0: `propose_test_change`, `report_progress`, `search_tools`/deferred tools, skills, `diff`, `render`.
- [ ] Record live trajectories (`--record`) for a CI trajectory-replay job (`--replay`).
- [ ] Reconcile the report name: the README row says `07-agent-bakeoff.md`, this file is `07-agent-vertical-slice.md`.

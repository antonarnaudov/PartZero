# Spike 08: Eval harness skeleton

- **Owner / workstream:** evals agent (Claude Code), main working tree (no git in this workstream)
- **Dates:** 2026-09-23 (interim report with 40 tasks) → 2026-09-23 (61 tasks, native Forge validated)
- **Commit(s):** uncommitted; `packages/evals/`, `corpus/makerbench/`
- **Verdict:** GO on the criterion (harness runs + 60 tasks): 61 MakerBench tasks, all passing on native Forge and on the OCCT oracle. Offscreen render is still open (see Verdict)

## Goal

Can we score an AI agent's CAD output automatically, reproducibly and cheaply enough to gate PRs? We need a headless harness plus a first set of MakerBench tasks whose hidden tests catch real mistakes.

Criteria, verbatim from [README.md](README.md):

| Setup | GO when |
|---|---|
| Headless harness (native Forge, offscreen render, agent) | Harness runs plus 60 MakerBench tasks |

Scope: IR v0 only (Forge F0: sketches of lines, arcs and circles; extrude and revolve, each creating new bodies; no booleans or fillets).
- The first iteration wrote 40 tasks: 25 T1, 8 T2, 4 T4 and 3 T5.
- The second iteration added 21 tasks (9 T1, 6 T2, 4 T4, 2 T5), bringing the total to 61. It also closed two gaps in the check DSL.

## Setup

**Code (`@aicad/evals`, MPL-2.0)**
- `packages/evals/schema/makerbench-task.schema.json`: the task format and the check DSL (JSON Schema 2020-12).
- `src/task.ts`: loading, plus schema and semantic validation.
- `src/checks.ts`: the DSL.
- `src/ir-geom.ts`: plane frames, full circles (circle curves and closed loops of co-circular arcs), hole containment and IR diffs.
- `src/engine.ts`: `ForgeCliEngine`, `OracleEngine`, `FixtureEngine`.
- `src/solver.ts` and `src/mutate.ts`: `ReferenceSolver`, `MutantSolver`.
- `src/pipeline.ts`: runner and scores.
- `src/report.ts`: Markdown report.
- `src/cli-main.ts`: `aicad-evals run | validate | fixtures`.

**Pipeline per task**

```
solver ─► CadScript compile ─► engine eval ─► hidden tests ─► score
(solver)  (compile)            (kernel)       (tests)
```

- The first stage that fails sets the task's failure category. A T4 context that can't be evaluated is `harness`.
- A task passes when three things hold: the candidate compiles, the report status is `ok`, and every hidden test passes.
- Metrics:
  - pass@1, per tier and overall;
  - validity rate: compiled, status `ok`, ≥1 body, every body valid;
  - hidden-test pass rate, overall and per check type;
  - failure categories;
  - cost: total, mean, p50, p90;
  - solver latency: p50, p90.
- Results are ordered by task id regardless of concurrency. `results.json` minus the `*_ms` fields is identical between runs; a test checks this.

**Corpus (`corpus/makerbench/`, Apache-2.0, hand-written)**
- 61 files named `<id>.task.json`: 34 T1, 14 T2, 8 T4 and 5 T5.
  - Each task has a reference `<id>.cad.ts`.
  - The 8 T4 tasks also have a `<id>.context.cad.ts`.
- 456 hidden tests in total, 5 to 15 per task (the schema requires at least 3). The 21 new tasks have 193 of them, 6 to 15 each.
- Every task declares `requires` (e.g. `["ir/0", "feature/revolve"]`).
  - A runner skips tasks that need capabilities its engine lacks, e.g. `--capabilities ir/0,feature/extrude`.
  - Later tiers add tokens like `op/boolean`, `op/fillet` and `assembly`.
- Volumes in the checks were derived analytically, not copied from an engine. The methods: shoelace; Pappus; frustum shells; spherical cap and hemisphere; circular segments and strips (∫√(R² − y²) dy); sector wedges. Only the first iteration's cable clip used numeric integration.
  - On both engines, every one of the 54 absolute volume targets is within 0.0085 %. The worst case is the numerically integrated cable clip.
  - The 21 new tasks are all within 0.0003 %, which is the rounding of the targets to two decimals.

**The 21 new tasks** (all IR v0; realistic maker parts for FDM, CNC and laser)

| Id | Tier | Title | What its hidden tests are after |
|---|---|---|---|
| `t1-esp32-devkit-plate` | T1 | ESP32 dev board mounting plate | M2.5 board pattern and M3 corner holes; pattern centred and holes 4 mm from the edges (edge offsets) |
| `t1-18650-cell-spacer` | T1 | 18650 cell spacer for a 4S2P pack | 18.6 mm holes on a 21 mm grid, centred (edge offsets) |
| `t1-m8-rod-end-cap` | T1 | Domed end cap for M8 threaded rod | revolve with a true hemisphere (sphere face) and an 8.4 mm blind bore |
| `t1-vacuum-hose-adapter` | T1 | Shop-vac hose adapter (32 mm port to 35 mm cuff) | revolve: sleeve, conical taper, spigot; 2 mm walls through the volume |
| `t1-screw-size-gauge` | T1 | Laser-cut metric screw size gauge | seven clearance holes (M2 to M8) as exact sizes, one row at 15 mm pitch, M2 hole 12 mm from the end |
| `t1-filament-clip` | T1 | Filament end clip for a spool rim | the slot is part of the outline (open), 2.2 mm holes placed from the edges |
| `t1-pegboard-plate` | T1 | Pegboard adapter plate | 1/4 in bolt holes on the 25.4 mm grid, M4 corner holes (edge offsets) |
| `t1-split-shaft-collar` | T1 | Split clamp collar blank for an 8 mm shaft | the bore is an arc and the slit breaks the ring (`inner_loops` = 0) |
| `t1-laser-mdf-panel` | T1 | Laser-cut MDF side panel with slots and cut-outs | tab slots, USB cut-out, jack and switch placed from the edges; the reference draws the switch hole as two arcs |
| `t2-stackable-tray-lid` | T2 | Stackable parts tray with lid | foot and lid ring share the 0.3 mm clearance interface; the divider stops 3 mm below the rim |
| `t2-lamp-base-stem` | T2 | Table lamp base and stem | two revolves assembled; socket clearance through the base volume (±0.05 %) |
| `t2-bearing-block-pair` | T2 | Pair of 608 bearing blocks | 22.1 mm seats on one shaft axis, blocks 100 mm apart, M5 feet |
| `t2-cable-organizer` | T2 | Desk cable organiser with five clips | five C-clips (closed-form profile area) on a 15 mm pitch, standing on the base |
| `t2-knob-skirt-set` | T2 | Pot knob with separate pointer skirt | a 20.2 skirt hole over a 20 mm knob; V-notch pointer; knob bore via volume |
| `t2-hinge-pair` | T2 | Two-leaf butt hinge blank | 0.3 mm axial and radial print-in-place clearances; three pin holes on one axis |
| `t4-hole-spacing` | T4 | Edit: change a hole pattern's spacing | new 38 x 24 pattern, still centred; hole size, cable hole and volume unchanged |
| `t4-multibody-m3-to-m4` | T4 | Edit: M3 to M4 holes across two parts | six holes in two parts changed in place; the 8 mm hole and both extrudes untouched |
| `t4-mirror-bracket` | T4 | Edit: mirror a bracket to make the other hand | a mirror made by editing coordinates (arcs must flip `ccw`); centroid mirrored, not shifted; volume and faces kept |
| `t4-revolve-half` | T4 | Edit: revolve 180° instead of 360° | half volume, two new end caps, profile untouched, only the revolve changed |
| `t5-arduino-box` | T5 | Under-specified: Arduino project box | plausibility (fits an Uno, hollow); `clarify` records the questions and the defaults |
| `t5-succulent-pot` | T5 | Under-specified: succulent pot | plausibility (pot-sized, hollow); `clarify` records the questions and the defaults |

**Engines**
- `OracleEngine`: `uv run oracle eval <file>` in `oracle/`.
- `ForgeCliEngine`: `forge/target/debug/aicad eval <file> --format json`. Build it with `cd forge && cargo build -p forge-cli`. It is now validated against the real binary (see Results).
- `FixtureEngine`: replays recorded reports, keyed by an IR content hash that ignores part and feature ids.
- Fixtures: 194 reports recorded from the oracle, in `packages/evals/fixtures/makerbench/`. That is 61 references, 8 contexts and 125 mutants (61 `scale`, 32 `drop_hole`, 32 `hole_size`).

**Dependencies**
- `ajv` 8.20 (MIT) and its dependencies: fast-deep-equal (MIT), fast-uri (BSD-3-Clause), json-schema-traverse (MIT), require-from-string (MIT).
- Workspace packages `@aicad/cadscript` and `@aicad/ir-types`.
- No new dependencies in the second iteration, and no external datasets.

**Hardware:** Apple M4 Pro, macOS 27.0, Node 22.16, uv 0.8.17, OCCT 7.9.3 (OCP 7.9.3.1.1) / build123d 0.12.0, Forge `aicad` debug build. Only macOS was tested.

**Commands**

```bash
pnpm install && pnpm -r build && pnpm -r test
(cd forge && cargo build -p forge-cli)                 # the native engine

# validate tasks and compile/type-check every reference and context
node packages/evals/dist/cli.js validate --tasks corpus/makerbench

# reference solver against the real engines (8 workers: oracle ≈7 s, Forge ≈0.8 s)
node packages/evals/dist/cli.js run --tasks corpus/makerbench --solver reference --engine oracle \
  --concurrency 8 --out artifacts/evals/reference-oracle --fail-under 1
node packages/evals/dist/cli.js run --tasks corpus/makerbench --solver reference --engine forge \
  --concurrency 8 --out artifacts/evals/reference-forge --fail-under 1

# mutants (scorer self-test): offline, or against a real engine
node packages/evals/dist/cli.js run --tasks corpus/makerbench --solver mutant:drop_hole --engine fixture
node packages/evals/dist/cli.js run --tasks corpus/makerbench --solver mutant:hole_size --engine forge

# re-record fixtures after editing a .cad.ts (≈35 s)
node packages/evals/dist/cli.js fixtures --tasks corpus/makerbench --engine oracle

# opt-in vitest suite against a real engine
AICAD_EVALS_REAL_ENGINE=oracle pnpm --filter @aicad/evals test real-engine
AICAD_EVALS_REAL_ENGINE=forge  pnpm --filter @aicad/evals test real-engine
```

### The check DSL

Each hidden test pairs **one measurement** with **one expectation**, plus a sentence for humans:

```json
{ "id": "size", "description": "50 x 50 mm plate, 5 mm thick, ±0.1 mm",
  "check": "bbox_sorted", "approx": [5, 50, 50], "abs": 0.1 }
```

**Expectations.** Exactly one of these:
- `eq`: deep equality.
- `approx`: needs `abs` and/or `rel`, and passes when |a − e| ≤ max(abs, rel·|e|). Vectors are compared element by element.
- `between`: an inclusive `[min, max]` range; vectors take one range per element.
- `gte` or `lte`.

For T4 tasks, `"$context"` as the expected value means "the same measurement taken on the starting model".

**Measurements**

| Kind | Checks | Notes |
|---|---|---|
| Model (report) | `status`, `valid`, `body_count`, `feature_count` (by `type`), `region_count`, `inner_loops` | `inner_loops` counts sketch holes across regions |
| Body (report) | `volume`, `area`, `centroid`, `bbox_size`, `bbox_sorted`, `bbox_min`, `bbox_max`, `face_count` / `edge_count` (by `type`) | Measured over all bodies (sums, union box, mass-weighted centroid), or over one body with `body` (0 = largest by volume, −1 = smallest). `axis` picks one component. `bbox_sorted` doesn't depend on orientation. |
| Quantifier | `bodies_matching` + `where: [...]` | Counts the bodies that meet every per-body condition. Used for multi-body T2 parts. |
| IR (compiled candidate) | `curve_count` (by `kind`, `diameter` range), `hole_pattern`, `hole_positions` (`relative_to`: `model` or `edges`), `feature_names`, `changed_curves`, `changed_features` | Details below. |

About the IR checks:
- **Full circles (new).** The IR checks see a hole as a full circle: either a `circle` curve or a closed loop of arcs on one circle. Such a loop, e.g. a hole drawn as two semicircles, as DXF/SVG exports and many agents produce, counts as one circle, not as arcs.
  - For a loop to count, its arcs must be joined end to end (1e-6 mm, each end meeting exactly one other), share a centre and radius (±1e-4 mm) and sweep a full turn.
  - An obround slot (arcs plus lines), a lens (arcs of two circles) or a D-shape (arc plus line) stays arcs.
  - `curve_count` counts these logical curves.
- `hole_pattern` compares the pairwise spacing of the circles whose diameter is in range. Placement, rotation and mirroring don't matter.
- `hole_positions` has two modes:
  - Default (`relative_to: "model"`): each given 3D point must lie on the axis of a distinct hole. A hole can be sketched on either face of a plate.
  - **`relative_to: "edges"` (new):** each point is an `[a, b]` pair, the hole's distances to the nearest side of the part's bounding box along the two directions across the hole. Pairs are order-free and matched to distinct holes. They use all bodies, or one body chosen with `body`.
    - This checks insets like "3.5 mm in from the edges" or "pattern centred on the plate" without fixing the placement or orientation.
    - It needs hole axes parallel to X, Y or Z.
    - It is mirror-invariant by design: a flat laser part is the same part flipped over.
- The `changed_*` checks diff the candidate's IR against the context, matching by feature name and curve id. They measure edit locality.

Validation happens in two layers:
- The JSON Schema enforces structure: known checks and parameters, one test id pattern, `approx` needs a tolerance, T4 needs `context`, T5 needs `clarify`.
- Semantic checks catch what the schema can't:
  - exactly one comparator;
  - parameters that belong to the check;
  - vector vs scalar;
  - `$context` only when a context exists;
  - the id matches the file name;
  - for `hole_positions`: 3D points in `model` mode, non-negative `[a, b]` pairs in `edges` mode, and `body` only in `edges` mode.

Failure messages are written as repair hints, for example:
- `found 0 circle(s) with a diameter in [3.2, 3.5], expected 4; circles present: Ø3.74 ×4, Ø22 ×1`
- `no hole [3.5, 3.5] mm from the nearest edges (±0.1, measured along X/Y); found [[3.5, 13.5], …]`

## Results

| Criterion | Target | Measured | Pass? |
|---|---|---|---|
| Harness runs headless (solver → compile → engine → tests → report) | runs | `aicad-evals run` works with the Forge, oracle and fixture engines. `results.json` and `report.md` are deterministic. | Yes |
| MakerBench tasks | 60 | **61** (34 T1 / 14 T2 / 8 T4 / 5 T5), 456 hidden tests, all solvable in IR v0 | **Yes** |
| Native Forge engine | runs | `ForgeCliEngine` on the real `aicad` binary: **61/61 tasks, 456/456 tests**, validity 100%, ≈0.8 s. Every numeric measurement matches the oracle to 1e-14 relative. | **Yes** |
| ReferenceSolver on real OCCT oracle | 100% | **61/61 tasks, 456/456 tests**, validity 100%, ≈7 s | Yes |
| ReferenceSolver on fixtures | 100% | 61/61 (vitest) | Yes |
| MutantSolver `scale` ×1.1 caught | all non-T5 | 56/56 caught on **both** the oracle and Forge. T5 (5/5) passes by design (plausibility only). | Yes |
| MutantSolver `drop_hole` caught | all non-T5 | 30/30 caught on both engines, by hole checks only; bbox, status and body count stay green | Yes |
| MutantSolver `hole_size` ×1.1 caught | all non-T5 | 30/30 caught on both engines | Yes |
| Mutant validity | 100% | every mutant evaluates to valid geometry on both engines, so tests fail for the right reason | Yes |
| Offscreen render | runs | not wired in (no `renders/` artifact yet) | No |
| Agent solver | runs | This spike still ships only the `Solver` interface. The LLM solver and bake-off CLI live in `packages/agent` ([spike 07](07-agent-vertical-slice.md)), where a scripted agent passes 3/3 T1 tasks through this pipeline. No live-LLM MakerBench run is recorded here. | Partly |
| Unit tests | green | `@aicad/evals`: **402 passed** + 3 opt-in real-engine tests, which pass against both the oracle and Forge. Downstream `@aicad/agent-tools` and `@aicad/agent` stay green. | Yes |

**Hand-written wrong and alternative candidates** (run through the real pipeline on the oracle; the Forge spot checks agree)

The mutants test generic mistakes. These probes test the task-specific ones and make sure the tests don't reject correct designs:

| Task | Candidate | Result | Failing tests |
|---|---|---|---|
| `t4-mirror-bracket` | x negated but arcs not flipped | fail | `centroid_x`, `centroid_y_kept`, `volume_kept` |
| `t4-mirror-bracket` | shifted by −60 instead of mirrored | fail | `m4_mirrored`, `centroid_x` |
| `t4-mirror-bracket` | mirrored with arc ends swapped instead of `ccw` flipped | pass (correct) | none |
| `t4-revolve-half` | `symmetric` or `reverse` 180° | pass (correct) | none |
| `t4-revolve-half` | 90° | fail | `half_volume`, `half_box` |
| `t4-hole-spacing` | right pattern, not centred | fail | `centred`, `only_holes_moved` |
| `t4-hole-spacing` | moved and resized | fail | `hole_size_kept`, `volume_kept` |
| `t4-multibody-m3-to-m4` | base only, strap forgotten | fail | `m4_all`, `no_m3`, `positions_kept`, `only_holes`, `volume` |
| `t4-multibody-m3-to-m4` | strap rebuilt under a new name | fail | `only_holes`, `extrudes_kept`, `same_features` |
| `t2-stackable-tray-lid` | walls modelled from the foot top, floor inside the ring | pass (correct) | none |
| `t2-stackable-tray-lid` | no stacking clearance | fail | `stacking_rings`, `foot_centred`, `volume` |
| `t1-split-shaft-collar` | bore drawn as two arcs | pass (correct) | none |
| `t1-split-shaft-collar` | closed ring, slit forgotten | fail | 5 tests |
| `t1-laser-mdf-panel` | switch hole as a `circle` (the reference uses two arcs) | pass (correct) | none |
| `t1-rpi4-plate` | Pi pattern centred along the plate instead of 3.5 mm from the end | fail | new `edge_inset` only (it passed every test before) |
| `t5-arduino-box` | a solid 84 x 69 x 35 brick | fail | `hollow` |

**Where the harness caught mistakes in my own tasks**

These are good evidence that you need both a real engine and mutants.

First iteration:
1. In `t2-enclosure-with-lid`, the "walls" test expected a body 30 mm tall. The reference's wall ring stands on the 2 mm floor, so it is 28 mm tall. The first real-oracle run caught this (39/40). The test now says "reaches the 30 mm rim" (`bbox_max.z`).
2. In `t1-sg90-mount`, the screw-hole diameter range [2.0, 2.5] also accepted the `hole_size` mutant's 2.42 mm. I tightened it to [2.1, 2.4]. Mutation testing found this; running the references would not have.

Second iteration: all 21 references passed on both engines on the first run. Two findings came from probing instead:
- The existing `t1-rpi4-plate` could not tell a centred Pi pattern from the real 3.5 mm end inset. `relative_to: "edges"` closes that gap.
- A mirrored layout of the MDF panel (jack and USB swapped) passes. That is correct, because it is the same flat part flipped over, and it is why edge offsets are mirror-invariant.

Design constraints the mutants impose, respected in every new task:
- Holes stay clear of each other and of the edges even when grown ×1.1 (e.g. the 18650 pitch is 21 mm, not 20).
- `hole_size`/`drop_hole` never change the body count or the bounding box.

**Scorer self-test (per-check pass rates under mutants)**
- Under `scale`, every `bbox_*` and `volume` check fails, and every topology check stays green: `face_count`, `inner_loops`, `feature_names`.
- The vitest suite asserts this per mutation, now over 61 tasks. At least one mutation-sensitive check must fail on each task, and no check that should be unaffected may fail.

## Verdict: GO (harness runs + 60 tasks)

The fixed criterion, "harness runs plus 60 MakerBench tasks", is met:
- there are 61 tasks, all IR v0;
- the harness runs headless end to end on native Forge, on the OCCT oracle and offline on fixtures;
- all 61 references pass 100% of their 456 hidden tests on both real engines, and the engines agree to 1e-14;
- every applicable mutant is caught on both engines;
- the hand-written probes show the tests reject task-specific wrong edits and accept legitimate alternative modelling.

Per criterion:

| Criterion | Verdict |
|---|---|
| Harness runs | GO |
| 60 MakerBench tasks | GO (61) |
| Native Forge | GO (validated, 61/61) |
| Agent | Partly. The solver interface is used by spike 07's LLM solver; no live-LLM numbers yet. |
| Offscreen render | Not done. Carried as a follow-up; it is not part of the GO condition. |

IR v0 was enough for 61 realistic tasks, but only because touching bodies stand in for booleans. The next richer parts need `op/boolean`, `op/fillet` and holes as features. Examples: counterbores, filleted brackets, a real Gridfinity profile, D-shaft bores and radial set-screw holes.

## Follow-ups

- [x] Run `aicad-evals run --engine forge --fail-under 1` on the MakerBench references. Done: 61/61.
- [ ] Add a CI job: `pnpm -r test` plus `run --engine fixture --fail-under 1`; `run --engine forge --fail-under 1` once CI builds `forge-cli`; and `oracle diff` on the MakerBench references.
- [x] Add 20 more tasks to reach 60. Done: 21, including T4 pitch, multi-part, mirror and revolve-angle edits.
- [ ] Next tasks: a first T3 (assembly) once the IR supports it; `op/boolean` / `op/fillet` parts tagged with `requires`.
- [ ] Agent solver: run spike 07's bake-off over all 61 tasks with live models. Record cost and latency, and keep T5 transcripts (the clarifying questions asked) for judge scoring against `clarify`.
- [ ] Offscreen render hook: add a `renders/` artifact per task with `forge-render`.
- [ ] Parametric-hygiene checks once CadScript v1 has `param()`: magic-number count and perturbation survival.
- [ ] Surface the new DSL features to agents (outside this workstream's files):
  - the spec writer's zod schema in `packages/agent-tools/src/spec.ts` drops `relative_to`;
  - `packages/agent/prompts/spec_writer.v1.md` doesn't document edge offsets or arc circles;
  - `docs/spikes/README.md` still lists this spike as "interim (40/60 tasks)".
- [ ] Known DSL limits:
  - [x] Holes drawn as arcs: closed loops of co-circular arcs now count as circles, so `curve_count`, `hole_pattern` and `hole_positions` find them.
  - [x] Hole offsets from an edge: `hole_positions` with `relative_to: "edges"`. Used by `t1-rpi4-plate` (3.5 mm inset), `t1-esp32-devkit-plate`, `t1-18650-cell-spacer`, `t1-screw-size-gauge`, `t1-filament-clip`, `t1-pegboard-plate` and `t1-laser-mdf-panel`.
  - Edge offsets are measured to the bounding box. That equals the real edges for rectangular outlines only, and the hole axes must be parallel to X, Y or Z.
  - `hole_pattern` compares distance multisets, which can't tell apart rare homometric point sets.
  - The `drop_hole` / `hole_size` mutants only touch `circle` curves. Holes drawn as arcs are not mutated.

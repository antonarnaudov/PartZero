# Spike 08: Eval harness skeleton

- **Owner / workstream:** evals agent (Claude Code), main working tree (no git in this workstream)
- **Dates:** 2026-09-23 → in progress (interim report)
- **Commit(s):** uncommitted; `packages/evals/`, `corpus/makerbench/`
- **Verdict:** NO-GO (interim): the harness runs, but there are 40 of the 60 tasks and native Forge is not validated yet

## Goal

Can we score an AI agent's CAD output automatically, reproducibly and cheaply enough to gate PRs? We need a headless harness plus a first set of MakerBench tasks whose hidden tests catch real mistakes.

Criteria, verbatim from [README.md](README.md):

| Setup | GO when |
|---|---|
| Headless harness (native Forge, offscreen render, agent) | Harness runs plus 60 MakerBench tasks |

Scope for this iteration: IR v0 only (Forge F0: sketches of lines, arcs and circles; extrude and revolve, each creating new bodies; no booleans or fillets). The target was 40 tasks: 25 T1, 8 T2, 4 T4 and 3 T5.

## Setup

**Code (`@aicad/evals`, MPL-2.0)**
- `packages/evals/schema/makerbench-task.schema.json`: the task format and the check DSL (JSON Schema 2020-12).
- `src/task.ts`: loading, plus schema and semantic validation.
- `src/checks.ts`: the DSL.
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
- 40 files named `<id>.task.json`. Each has a reference `<id>.cad.ts`. The 4 T4 tasks also have a `<id>.context.cad.ts`.
- 262 hidden tests in total, 5 to 9 per task (the schema requires at least 3).
- Every task declares `requires` (e.g. `["ir/0", "feature/revolve"]`). A runner skips tasks that need capabilities its engine lacks, e.g. `--capabilities ir/0,feature/extrude`. Later tiers add tokens like `op/boolean`, `op/fillet` and `assembly`.
- Volumes in the checks were derived analytically (shoelace, Pappus, spherical cap; the cable clip by numeric integration), not copied from an engine. The oracle agrees with every one to within 0.01 %.

**Engines**
- `OracleEngine`: `uv run oracle eval <file>` in `oracle/`.
- `ForgeCliEngine`: `forge/target/debug/aicad eval <file> --format json`. The binary does not exist yet, and the engine reports that through `availability()`.
- `FixtureEngine`: replays recorded reports, keyed by an IR content hash that ignores part and feature ids.
- Fixtures: 120 reports recorded from the oracle, in `packages/evals/fixtures/makerbench/`. That is 40 references, 4 contexts and 76 mutants.

**Dependencies**
- `ajv` 8.20 (MIT) and its dependencies: fast-deep-equal (MIT), fast-uri (BSD-3-Clause), json-schema-traverse (MIT), require-from-string (MIT).
- Workspace packages `@aicad/cadscript` and `@aicad/ir-types`.
- No external datasets.

**Hardware:** Apple M4 Pro, macOS 27.0, Node 22.16, uv 0.8.17, OCCT 7.9.3 (OCP 7.9.3.1.1) / build123d 0.12.0. Only macOS was tested.

**Commands**

```bash
pnpm install && pnpm -r build && pnpm -r test

# validate tasks and compile/type-check every reference and context
node packages/evals/dist/cli.js validate --tasks corpus/makerbench

# reference solver against the real OCCT oracle (≈6 s with 8 workers)
node packages/evals/dist/cli.js run --tasks corpus/makerbench --solver reference --engine oracle \
  --concurrency 8 --out artifacts/evals/reference-oracle --fail-under 1

# mutants (scorer self-test), offline
node packages/evals/dist/cli.js run --tasks corpus/makerbench --solver mutant:drop_hole --engine fixture

# re-record fixtures after editing a .cad.ts (≈15 s)
node packages/evals/dist/cli.js fixtures --tasks corpus/makerbench --engine oracle

# opt-in vitest suite against a real engine
AICAD_EVALS_REAL_ENGINE=oracle pnpm --filter @aicad/evals test real-engine
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
| IR (compiled candidate) | `curve_count` (by `kind`, `diameter` range), `hole_pattern`, `hole_positions`, `feature_names`, `changed_curves`, `changed_features` | Details below. |

About the IR checks:
- `hole_pattern` compares the pairwise spacing of the circles whose diameter is in range. Placement, rotation and mirroring don't matter.
- `hole_positions` requires each given 3D point to lie on the axis of a distinct hole. A hole can be sketched on either face of a plate.
- The `changed_*` checks diff the candidate's IR against the context, matching by feature name and curve id. They measure edit locality.

Validation happens in two layers:
- The JSON Schema enforces structure: known checks and parameters, one test id pattern, `approx` needs a tolerance, T4 needs `context`, T5 needs `clarify`.
- Semantic checks catch what the schema can't: exactly one comparator, parameters that belong to the check, vector vs scalar, `$context` only when a context exists, and the id matches the file name.

Failure messages are written as repair hints, for example: `found 0 circle(s) with a diameter in [3.2, 3.5], expected 4; circles present: Ø3.74 ×4, Ø22 ×1`.

## Results

| Criterion | Target | Measured | Pass? |
|---|---|---|---|
| Harness runs headless (solver → compile → engine → tests → report) | runs | `aicad-evals run` works with oracle and fixture engines, deterministic `results.json` + `report.md` | Yes |
| MakerBench tasks | 60 | 40 (25 T1 / 8 T2 / 4 T4 / 3 T5), 262 hidden tests | No (67%) |
| Native Forge engine | runs | `ForgeCliEngine` implemented and tested against a fake `aicad`; real binary not built yet | No (not validated) |
| Offscreen render | runs | not started (no `forge-render` yet) | No |
| Agent solver | runs | `Solver` interface only; no LLM solver yet (see follow-ups) | No |
| ReferenceSolver on real OCCT oracle | 100% | **40/40 tasks, 262/262 tests**, validity 100%, ≈6 s | Yes |
| ReferenceSolver on fixtures | 100% | 40/40 (vitest) | Yes |
| MutantSolver `scale` ×1.1 caught | all non-T5 | 37/37 caught; T5 passes by design (plausibility only) | Yes |
| MutantSolver `drop_hole` caught | all non-T5 | 17/17 caught, by hole checks only; bbox, status and body count stay green | Yes |
| MutantSolver `hole_size` ×1.1 caught | all non-T5 | 17/17 caught (after one fix, below) | Yes |
| Unit tests | green | `@aicad/evals`: 277 passed + 3 opt-in real-engine tests (pass against the oracle) | Yes |

**Where the harness caught mistakes in my own tasks**

These are good evidence that you need both a real engine and mutants:
1. In `t2-enclosure-with-lid`, the "walls" test expected a body 30 mm tall. The reference's wall ring stands on the 2 mm floor, so it is 28 mm tall. The first real-oracle run caught this (39/40). The test now says "reaches the 30 mm rim" (`bbox_max.z`).
2. In `t1-sg90-mount`, the screw-hole diameter range [2.0, 2.5] also accepted the `hole_size` mutant's 2.42 mm. I tightened it to [2.1, 2.4]. Mutation testing found this; running the references would not have.

**Scorer self-test (per-check pass rates under mutants)**
- Under `scale`, every `bbox_*` and `volume` check fails, and every topology check stays green: `face_count`, `inner_loops`, `feature_names`.
- The vitest suite asserts this per mutation. At least one mutation-sensitive check must fail on each task, and no check that should be unaffected may fail.

## Verdict: NO-GO (interim)

The harness itself is solid. I'm highly confident in the parts that exist:
- the task format, DSL, pipeline and reports work end to end;
- all references pass on real OCCT;
- mutants show the hidden tests catch the typical agent mistakes (wrong scale, missing hole, wrong clearance) without false alarms on unrelated checks.

The fixed criterion is not met yet:
- there are 40 of the 60 tasks;
- native Forge, offscreen render and an agent solver aren't wired in.

None of these is a design risk. Each has a direct follow-up below. The remaining 20 tasks should wait for the features that the richer T1/T2 parts need (booleans, fillets, holes as features), since IR v0 is exhausted fast for realistic maker parts.

## Follow-ups

- [ ] When `forge-cli` lands, run `aicad-evals run --engine forge --fail-under 1` and `oracle diff` on the MakerBench references. Add a CI job with `pnpm -r test` plus `run --engine fixture --fail-under 1`.
- [ ] Add 20 more tasks to reach 60. Candidates:
  - more T4 edits: move holes, change a pattern pitch, rename-safe edits;
  - a first T3 (assembly) once the IR supports it;
  - `op/boolean` / `op/fillet` parts tagged with `requires`: counterbored plates, filleted brackets, real Gridfinity profile, D-shaft knob.
- [ ] Agent solver on top of `packages/llm-gateway`. Record cost and latency and write T5 transcripts (the clarifying question asked) for judge scoring against `clarify`.
- [ ] Offscreen render hook: add a `renders/` artifact per task once `forge-render` exists.
- [ ] Parametric-hygiene checks once CadScript v1 has `param()`: magic-number count and perturbation survival.
- [ ] Known DSL limits:
  - Holes are detected as sketch circles, so a hole drawn as two arcs is missed.
  - `hole_pattern` compares distance multisets, which can't tell apart rare homometric point sets.
  - Hole offsets from an edge (e.g. the Raspberry Pi's 3.5 mm inset) aren't checked, except in T4 tasks, where `hole_positions` uses the fixed context frame.

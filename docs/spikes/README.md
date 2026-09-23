# Phase 0 spikes

Phase 0 (M1–M2) de-risks the plan through eight go/no-go spikes ([ROADMAP.md](../ROADMAP.md#phase-0-foundations-and-spikes-m1m2)).
- Spike 1 is the main Forge F0 track.
- Spikes 2–8 run in parallel worktrees.
- Each spike ends with a report in this folder, named `docs/spikes/NN-name.md` (e.g. [`02-naming.md`](02-naming.md) — **GO**), using the template below.

**Rules:**
- **Criteria are fixed before the spike starts.** If a criterion turns out to be wrong, record the change and the reason in the report. Don't silently move the bar.
- **A NO-GO is a valid outcome.** It must come with a follow-up: a changed approach, a re-scoped milestone or a new ADR.
- **Numbers come from reproducible runs.** Record the commands, commit and hardware.

## Spikes and go/no-go criteria

| # | Spike | Setup | GO when | Report |
|---|---|---|---|---|
| 1 | **Forge F0 core + oracle harness** | `forge-core`, regions, extrude, revolve, tessellation, mass properties, STL/3MF, `aicad` CLI; `oracle/` evaluator and `kernel-diff` | <ul><li>Bit-identical output on macOS, Windows, Linux and WASM.</li><li>Extrude and revolve match the OCCT oracle on 1k programs.</li><li>napi and WASM builds both work in the CLI and in Electron.</li></ul> | [`01-forge-f0-oracle.md`](01-forge-f0-oracle.md) — **GO** (cross-OS CI, napi pending) |
| 2 | **Native provenance naming harness** | 12–20 maker models, 10 scripted mutations each | <ul><li>≥97% correct on dimension and suppress edits.</li><li>≥90% correct on topology-changing edits.</li><li>**100% of fallbacks flagged.**</li></ul> | [`02-naming.md`](02-naming.md) — **GO** |
| 3 | **SSI + boolean feasibility** | Certified intersection for plane/cylinder/cone/sphere/torus pairs; booleans on 500 DeepCAD replays | <ul><li>≥99% agreement with the oracle.</li><li>0 silent-wrong results.</li></ul> The result sets the pace for F1. | `03-ssi.md` (SSI half, in progress); booleans next |
| 4 | **`forge-solve` sketch solver** | 60–200-entity sketches; 1k generated sketches | <ul><li>≤4 ms per drag frame (WASM).</li><li>DOF counts, redundancy and minimal conflict sets match PlaneGCS/SolveSpace on 1k generated sketches.</li></ul> | [`04-sketch-solver.md`](04-sketch-solver.md) — **GO** |
| 5 | **`forge-render` in Electron** | wgpu renderer on WebGPU with a WebGL2 fallback | <ul><li>Exact edges and silhouettes.</li><li>Pixel-exact ID picking.</li><li>Section view.</li><li>WebGL2 fallback works on Linux.</li><li>A dimension edit shows up in 3D within ≤150 ms.</li></ul> | [`05-renderer.md`](05-renderer.md) — **GO** (Linux WebGL2 pending) |
| 6 | **CadScript ⇄ IR round-trip** | Compiler + canonical printer; property tests on 50 models | <ul><li>Lossless on 50 models.</li><li>UI edits keep comments and formatting.</li></ul> | [`06-cadscript-roundtrip.md`](06-cadscript-roundtrip.md) — **GO** |
| 7 | **Agent vertical slice + bake-off** | About 12 tools; Anthropic, OpenAI and Google flagships; CadScript vs build123d-MCP on 30 T1 tasks. Early runs may evaluate CadScript through the `oracle/` backend. | <ul><li>CadScript ≥ build123d's score minus 5 points.</li><li>≥50% of hidden tests passing.</li><li>Median cost ≤$1.</li></ul> On a loss, change the syntax, not the engine. | [`07-agent-vertical-slice.md`](07-agent-vertical-slice.md) — offline slice done; live bake-off needs API keys |
| 8 | **Eval harness skeleton** | Headless harness (native Forge, offscreen render, agent) | Harness runs plus 60 MakerBench tasks | [`08-eval-harness.md`](08-eval-harness.md) — interim (40/60 tasks) |

The **Phase 0 deliverables** alongside the spikes:
- ADRs ([../adr/](../adr/README.md));
- a decision memo;
- a landing page and waitlist;
- a public "building an AI-native kernel" dev log.

## Report template

Copy this into `docs/spikes/NN-name.md`.

```markdown
# Spike NN: <name>

- **Owner / workstream:** <agent or person>, <worktree/branch>
- **Dates:** YYYY-MM-DD → YYYY-MM-DD
- **Commit(s):** <sha>
- **Verdict:** GO | NO-GO

## Goal

What question this spike answers, and the go/no-go criteria copied verbatim from docs/spikes/README.md.

## Setup

- Code, corpus and datasets used (with licences checked)
- Hardware and targets (macOS / Windows / Linux / wasm32)
- Exact commands to reproduce

## Results

| Criterion | Target | Measured | Pass? |
|---|---|---|---|
| | | | |

Notable failures, with links to failure-zoo cases:

## Verdict: GO | NO-GO

One paragraph: why, and with what confidence. For a NO-GO, say what would have to change.

## Follow-ups

- [ ] Issues, ADRs to write or amend, milestone or roadmap changes
```

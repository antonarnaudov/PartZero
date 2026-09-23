# CLAUDE.md — guide for coding agents (and humans)

This repo is built almost entirely by AI coding agents. Read this file before changing anything. `AGENTS.md` points here.

## What we're building
An AI-native 3D CAD app. It rests on three pieces:
- **Forge:** our own geometry kernel and engine, written in Rust.
- **The Feature-Graph IR:** the single source of truth for a design.
- **CadScript:** a statically compiled TypeScript subset. Both the in-app agent and power users edit it.

The full plan is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/FORGE.md](docs/FORGE.md) and [docs/ROADMAP.md](docs/ROADMAP.md). Decisions are recorded in [docs/adr/](docs/adr/).

## Non-negotiable principles
1. **Own the core; borrow only as oracles.**
   - Don't add a runtime dependency on another CAD kernel, constraint solver, mesher or renderer.
   - OCCT, PlaneGCS, SolveSpace, OpenSubdiv, Manifold and CalculiX may be used **only** in `oracle/` or CI test tooling.
   - Small generic crates are fine (serde, thiserror, smallvec, proptest…). Anything that decides geometric quality is ours.
2. **Never return silently wrong geometry.**
   - Every kernel operation either returns a valid result or a structured, explainable error.
   - A silent-wrong result found by the oracle blocks a release.
3. **Deterministic, bit-identical results on every target** (macOS, Windows, Linux, wasm32).
4. **Verification first.** Every new operation arrives with the following, all in the same PR:
   - unit tests;
   - property tests;
   - invariant checks;
   - an oracle comparison case.
5. **No runtime LGPL/GPL.** Check the license of every new dependency. CI runs `cargo deny` and a JS license check.

## Repo map
```
forge/            Rust workspace (MPL-2.0)
  crates/forge-core     scalar trait (f64/Dual/Interval), math, exact predicates, arenas/typed ids, geometry, seam-free topology + provenance
  crates/forge-ir       Feature-Graph IR types (serde + JSON Schema) + normative SPEC.md — the contract with TS and the oracle
  crates/forge-ops      modeling operations (sketch regions, extrude, revolve; booleans/fillets next)
  crates/forge-ssi      surface–surface / curve–surface intersection (foundation for booleans)
  crates/forge-check    exact mass properties, tight bbox, validation, metrics
  crates/forge-mesh     watertight seam-free tessellation, own CDT, render meshes
  crates/forge-io       STL / 3MF / OBJ readers & writers (our own); STEP planned
  crates/forge-regen    IR evaluation → bodies + aicad.metrics reports
  crates/forge-solve    own 2D constraint solver with DOF / redundancy / minimal-conflict diagnostics
  crates/forge-naming   persistent-reference resolver + naming stability harness
  crates/forge-render   own wgpu CAD renderer (WebGPU + WebGL2 fallback): edges, silhouettes, ID picking, sections
  crates/forge-wasm     wasm-bindgen bindings (evaluate, exportMesh, Viewport)
  crates/forge-cli      `aicad` binary: eval / export (the harness for agents and CI)
packages/         TypeScript (pnpm + Turborepo)
  ir-types        TS types + zod generated from forge-ir schemas (Apache-2.0)
  cadscript       CadScript compiler / printer / edit splicing / typecheck (Apache-2.0)
  forge-web       JS API over forge-wasm (engine + renderer), worker evaluator, demo
  llm-gateway     model-agnostic LLM layer (Anthropic, OpenAI, Google, OpenAI-compatible)
  agent-tools     DesignSession + strict tools + error-code repair playbooks
  agent           orchestrator state machine, prompts, LLMSolver, bake-off CLI
  evals           MakerBench runner, check DSL, engines (forge CLI / oracle / fixtures)
  app             React UI (timeline, code view, viewport, chat, command layer)
  desktop         Electron shell (sandboxed, app:// with COOP/COEP), e2e tests
oracle/           Python (uv): OCCT/build123d evaluator of the same IR, differential diff, program generator (CI only)
corpus/           IR programs, golden reports, CadScript prints, MakerBench tasks
skills/           part-family skills for the agent
docs/             vision, architecture, Forge, roadmap, research, ADRs, spike reports, BACKLOG
```

## Commands
```bash
# Rust (run from forge/)
cargo test --workspace                 # all tests
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p forge-cli -- eval ../corpus/programs/extrude_box.json   # metrics JSON for one IR doc
cargo build -p forge-wasm --target wasm32-unknown-unknown            # (once the crate exists)

# Oracle (run from oracle/)
uv run oracle eval ../corpus/programs/extrude_box.json               # the same metrics, computed with OCCT
uv run oracle diff ../corpus/programs                                # Forge vs OCCT over a directory

# TypeScript (repo root)
pnpm install && pnpm -r build && pnpm -r test
pnpm --filter @aicad/desktop dev          # run the desktop app (Vite + Electron)
pnpm --filter @aicad/desktop test:e2e     # Playwright-Electron smoke tests
node packages/evals/dist/cli.js run --tasks corpus/makerbench --engine oracle   # MakerBench
```

## Rust conventions (Forge)
- **Topology lives in arenas with typed generational IDs** (`FaceId`, `EdgeId`, …).
  - No `Rc<RefCell<…>>` pointer graphs.
  - IDs never leave the process. Anything persisted uses provenance or semantic names.
- **Numeric code is generic over the `Scalar` trait** wherever that's practical: `f64` now; `Interval`, `Dual` and `Rational` later.
  - Don't hardcode `f64` in algorithms that we'll want to certify or differentiate.
- **Determinism rules:**
  - No iteration over `HashMap`/`HashSet` where the order can reach an output. Use `BTreeMap`, `IndexMap` or sorted `Vec`.
  - No fast-math.
  - Transcendentals go through `forge_core::math` wrappers, which will be backed by a portable libm. They never call platform intrinsics directly.
  - Parallelism (rayon) is allowed only where the result doesn't depend on scheduling.
- **Robust predicates:**
  - Orientation and incircle-style decisions use `forge_core::predicates` (adaptive exact).
  - Never compare raw floats against a magic epsilon inside topology decisions.
  - Tolerances are explicit, named and documented (`Tolerance` struct).
- **Errors:**
  - Use `thiserror` enums that carry a machine-readable `code` plus structured context (entity IDs, feasible ranges).
  - These errors feed the agent's repair hints, so make them precise.
- **`unsafe`:** not allowed without an ADR.
- **Tests:**
  - `proptest` for properties.
  - Invariant checkers (`forge-check::validate`) run after every op in debug and test builds.
  - Name tests after the behavior they check.

## TypeScript conventions
- Strict TS.
- zod types are generated from the IR JSON Schema. Don't hand-write IR types.
- Every state change is a domain op inside a transaction, including the inverse op, so undo works.
- The UI, agent, CLI and MCP all call the same command layer.

## Python (oracle)
- `uv` manages the environment. The Python version is pinned in `oracle/.python-version`, because OCP wheels lag behind CPython releases.
- The oracle must implement **exactly** the IR semantics documented in `forge-ir`. If they disagree, fix the spec first.

## How to verify your change
1. `cargo test --workspace` and `cargo clippy` are clean.
2. For geometry changes, run the oracle diff on `corpus/programs`. Differences must be explained or fixed, never ignored.
3. Update the relevant doc or ADR if you changed a decision or contract.

## Git
- Keep commits small and focused, with imperative subject lines.
- Don't commit generated corpora, large datasets or build artifacts. See `.gitignore`.

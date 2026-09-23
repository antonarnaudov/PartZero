# Spike 01: Forge F0 core + oracle harness

- **Owner / workstream:** coordinator + Forge core, modeling, mesh/IO and oracle agents (main branch)
- **Dates:** 2026-09-23 → 2026-09-23 (interim)
- **Commit(s):** d6b3576 (forge-core), 79bad0c (F0 modeling), a88f2f5 (mesh/io), 65f7ee6 (export), 97a4eeb (oracle bbox fix); report at 97a4eeb
- **Verdict:** **GO for the kernel. Two criteria are pending:** cross-OS CI and the napi/Electron build.

## Goal
Can our own kernel, Forge, evaluate IR v0 (sketch regions, extrude, revolve) exactly and deterministically, verified by an independent OCCT oracle?

GO criteria, verbatim:
- Bit-identical output on macOS, Windows, Linux and WASM.
- Extrude and revolve match the OCCT oracle on 1k programs.
- napi and WASM builds both work in the CLI and in Electron.

## Setup
- **Forge crates:**
  - `forge-core`: scalars, exact predicates, arenas, geometry, seam-free topology.
  - `forge-ops`: regions, extrude, revolve.
  - `forge-check`: exact mass properties via divergence and Green's theorem, tight bbox, validation.
  - `forge-regen`, `forge-cli` (`aicad`).
  - `forge-mesh` and `forge-io`.
- **Oracle:** `oracle/` on build123d 0.12 and OCCT 7.9.3. It implements IR SPEC v0 (revision 23c) independently and has an analytic self-check gate.
- **Programs:** 8 hand-written corpus programs, plus 6,000 generated programs (`oracle gen`, seeds 5, 11 and 23) and 210 error-corpus programs.
- **Hardware:** Apple Silicon (aarch64-darwin), Rust 1.92. wasm32 was run under Node.
- **Reproduce:**
  ```bash
  cd forge && cargo build -p forge-cli
  cd ../oracle && uv run oracle gen --count 2000 --seed 23
  uv run oracle diff ../corpus/generated/s23 --forge-bin ../forge/target/debug/aicad
  uv run oracle diff ../corpus/programs --forge-bin ../forge/target/debug/aicad
  ```

## Results
| Criterion | Target | Measured | Pass? |
|---|---|---|---|
| Oracle agreement, extrude/revolve | 1k programs match | 6,008/6,008 generated and corpus programs MATCH; 210/210 error-corpus MATCH; 2 remaining are OCCT defects where Forge equals the closed form | **Yes** |
| Silent-wrong results | 0 | 0 | **Yes** |
| Bit-identical on macOS + wasm32 | identical | forge-core golden hash identical on aarch64-darwin and wasm32 (debug and release); mesh and file-format bytes identical native vs wasm32 | **Yes** (these two targets) |
| Bit-identical on Windows + Linux | identical | not yet run (needs the CI matrix) | Pending |
| napi + WASM builds in CLI and Electron | both work | CLI is native; the WASM build is in progress (spike 05); napi not started | Pending |

**OCCT defects the oracle caught.** All three are pinned as tests:
1. A partial revolve of a small circle tangent to the axis produced an invalid solid.
2. A 311.5° revolve returned a full 360° torus, so the volume was 15% too large.
3. A line 1e-4 rad off parallel to the axis was snapped to a cylinder, giving a volume error of 2.9e-7.

**Oracle bug found through Forge.** OCCT's `AddOptimal` under-estimates the bounding box of surfaces of revolution. The fix is to use closed-form extremes.

**Exactness.** Corpus volumes match their closed forms to about 1e-15 relative. A mesh export at 0.05 mm deflection is watertight, and its volume is within 0.04–0.3% of exact.

## Verdict
**GO on the kernel question.** A from-scratch AI-native kernel met the "match or beat OCCT" bar on its first milestone. Two things remain before F0 is fully closed:
1. Run the determinism golden test on x86_64 Linux and Windows (CI matrix).
2. Get the Forge WASM and napi builds running inside Electron (spikes 05 and 07).

## Follow-ups
- Cross-OS determinism in CI.
- napi build for the Electron utility process.
- A nightly differential job with a fresh seed.
- Curve-id escaping in provenance names (BACKLOG).
- Cache per-body analysis in regen.

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
| Oracle agreement, extrude/revolve | 1k programs match | 6,008/6,008 generated and corpus programs MATCH; 210/210 error-corpus MATCH; 2 remaining are OCCT defects where Forge equals the closed form. The later `degenerate_loop` kind is 8/120 ROBUSTNESS on the current tree (open regression, see "Automation" below) | **Yes** (before that regression) |
| Silent-wrong results | 0 | 0 | **Yes** |
| Bit-identical on macOS + wasm32 | identical | forge-core golden hash identical on aarch64-darwin and wasm32 (debug and release); mesh and file-format bytes identical native vs wasm32. Re-checked 2026-09-23 on wasm32-wasip1 (debug, Node WASI): the forge-solve goldens pass on the current tree; the forge-core, forge-mesh and forge-io golden tests reproduce the native constants only on a snapshot with proptest's `fork`/`timeout` features switched off in `forge/Cargo.toml`, a change that is **not in the tree** (on the tree those three crates' tests do not compile for WASI; see below) | **Yes** (these two targets, measured locally) |
| Bit-identical on Linux | identical | **linux/arm64 (native) and linux/amd64 (Docker, emulated): 828/828 output files byte-identical to aarch64-darwin** over 208 programs (see below) | **Yes** (amd64 emulated, not real x86_64 hardware) |
| Bit-identical on Windows | identical | not yet run (needs the CI matrix) | Pending |
| napi + WASM builds in CLI and Electron | both work | CLI is native; the WASM build is in progress (spike 05); napi not started | Pending |

**Linux verification (2026-09-23 audit, `docs/audits/2026-09-23-phase0-audit.md` §1.1).**
- **Scope.** 208 programs: the 8 in `corpus/programs` plus `gen_s23_00000`–`00199`, all built from one frozen source snapshot with rustc 1.92.0 (LLVM 21.1.3), release, `codegen-units=1`.
- **Compared outputs.** `aicad eval --format json` reports, 3MF exports, stderr and exit codes: 828/828 files identical for macOS vs linux/arm64 and for macOS vs linux/amd64 (whole-tree SHA-256 `e5bc7eff…228d` on all three). They cover 367 bodies, 4,390 report floats and 590,824 triangles, all printed as shortest round-trip f64, so a 1-ulp difference would show.
- **Golden test.** `determinism_golden` (forge-core) passes in debug and release on all three: `0x8dc3_44c3_aa7e_8748`.
- **Only normalization:** the absolute path in the export's `wrote …` stderr line.
- **Caveats.** linux/amd64 ran under emulation, not on x86_64 hardware. Five s23 revolve programs evaluate fine but fail to export (`cannot tessellate … estimated deviation inf`, exit 3), identically on every platform.

**Still open for the determinism criterion:** Windows; real x86_64 hardware; and wasm32 inside CI. `.github/workflows/ci.yml` has jobs for all three (the `forge` matrix on ubuntu/macos/windows-latest, and the `forge-wasm` job running the golden tests on wasm32-wasip1 under wasmtime), but the repository has no remote yet, so CI has never run. The `forge-wasm` job also cannot pass yet: its forge-core and forge-mesh/forge-io steps fail to compile until `forge/Cargo.toml` sets `proptest = { version = "1", default-features = false, features = ["std", "bit-set"] }` (or those crates gate their proptest dev-dependency on `cfg(not(target_family = "wasm"))`, as forge-solve does). The default `fork` feature pulls in `rusty-fork` → `wait-timeout`, which does not build for WASI. Only its forge-solve step works on the current tree (audit M4, open).

**Automation of the headline numbers.** The oracle-agreement numbers above were local runs. `ci.yml` (job `oracle-diff`) now builds `aicad` and diffs it against the oracle on every push: `corpus/programs`, 200 generated programs (seed 1) and the error corpus, failing on any class other than MATCH. `.github/workflows/nightly.yml` runs 1000 fresh programs (seed = run number) plus the error corpus, and MakerBench on the real Forge engine. The error corpus now also covers `SKETCH_DEGENERATE_LOOP` [R-5] (kind `degenerate_loop`: a loop of area exactly tol², and just above); the "210/210" above predates it and did not exercise R-5. The 120 `degenerate_loop` cases of seeds 0–9 (debug `aicad`, 2026-09-23):
- **120/120 MATCH** with a binary built before the uncommitted audit-L1 change to `forge-core/src/topo/validate.rs`.
- **112/120 MATCH, 8 ROBUSTNESS with the current tree** (`inv_s1_…_001`, `s3_005`, `s3_009`, `s5_003`, `s5_011`, `s7_001`, `s8_009`, `s9_009`). All eight are the just-above control (area 1.000000001·tol²): Forge's sketch accepts the triangle, then body validation re-checks `|area| ≤ tol²` on plane coordinates that went through the 3D round trip and rejects the extruded face (`INVALID_RESULT` / `LOOP_DEGENERATE`, "loop encloses area 9.999999988366896e-13, at most tolerance² = 1e-12"), while the oracle returns ok. This is an **open Forge regression** in `validate.rs`. Until it is fixed, the per-push error-corpus diff of `oracle-diff` fails (seed 1: `inv_s1_degenerate_loop_001`; MATCH=71, ROBUSTNESS=1).

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

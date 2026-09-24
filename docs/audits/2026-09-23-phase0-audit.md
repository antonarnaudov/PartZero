# Phase 0 audit: Linux verification and findings

Repo: PartZero (this repository). Date: 2026-09-23. The paths that are in flux were left out of scope: `forge-ssi`, `forge-core/.../implicit.rs`, `forge-ir` (v1), `packages/ir-types` and `corpus/v1`. No repository files were modified.
Scratchpad (`$S`): `$SCRATCH (session scratchpad, not retained)`.

**Summary.** Both Linux Phase 0 criteria **PASS**.

The audit has **45 confirmed findings** after de-duplication: 0 critical, 3 high, 19 medium and 23 low.

The most serious problem is principle 2, "never return silently wrong geometry". Two forge-check defects report wrong metrics with status `ok`: revolves close to 360°, and the tight bbox of spindle and horn faces. The CI job that should catch this never runs Forge. It also has never actually run, because the repo has no remote.

**Severity rule.** Each finding takes the majority of its verifiers' adjusted severities. When the vote is tied 1–1, the finding keeps its originally reported severity. Each entry shows the original severity and the votes (C/H/M/L).

---

## 1. Phase 0 Linux verification

### 1.1 Spike 1: "bit-identical output on macOS, Windows, Linux and WASM" (Linux part)

**Verdict: PASS.** linux/arm64 was run natively. linux/amd64 ran under Docker Desktop emulation. Both were compared against the aarch64-apple-darwin reference. The criterion as a whole stays **open** until Windows, wasm32 and real x86_64 hardware are covered.

**Evidence**
- **Scope.** 208 programs: the 8 in `corpus/programs` plus `gen_s23_00000`–`00199` (in `LC_ALL=C` sort order). All three platforms built from one frozen snapshot, because `forge-ir` changed during the run. The snapshot's manifest is `$S/determinism/snap_manifest.sha256`.
- **Toolchain.** rustc 1.92.0 (`ded5c06cf`) with LLVM 21.1.3 on all three platforms. Release builds with `codegen-units=1`. The binaries are in `$S/determinism/bin/`: mac `08f646c4…`, arm64 `425a80bf…`, amd64 `98bdb0e6…`.
- **Output comparison.** `compare.py` found 828/828 files identical for mac vs linux-arm64 and 828/828 for mac vs linux-amd64 (203 3MF files, 208 reports, 416 stderr files, `status.tsv`). The whole-tree SHA-256 is `e5bc7eff…228d` on all three platforms.
- **Coverage of the compared outputs.** 367 bodies from 236 sketch, 155 extrude and 95 revolve features. 4,390 report floats. 295,539 vertices and 590,824 triangles. Reports and 3MF both use shortest-round-trip f64 with no rounding, so a 1-ulp difference would have shown up.
- **Golden test.** `determinism_golden` passed in debug and release on all three platforms: fingerprint == `GOLDEN 0x8dc3_44c3_aa7e_8748`.
- **Exit codes.** Identical on all platforms. 203 programs had eval 0 and export 0. Five had eval 0 and export 3, with byte-identical error text.
- **Normalization.** The only thing normalized was the export stderr line `wrote <abs path>`, which differs only by mount point.
- **Static check.** On macOS the only libm import is `_fmod`, which comes from `deg % 360.0` at `forge-core/src/math.rs:138`. On Linux, `fmod` is linked statically from compiler-builtins. fmod is exact. The source contains no `mul_add` or `powi`.

**Commands**
```
rsync forge/ (minus target) + corpus/{programs,golden} + first 200 gen_s23_[0-9]*.json → $S/determinism/snap; shasum → snap_manifest.sha256
cd snap/forge && CARGO_TARGET_DIR=$S/target-mac cargo build --release -p forge-cli
bash determinism/run.sh <aicad> <snap>/corpus determinism/<platform>   # eval --format json; export --out x.3mf (+--allow-partial on exit 1)
cargo test [--release] -p forge-core --test determinism_golden
docker run --rm --platform linux/arm64 -v snap:/repo:ro -v determinism:/out rust:1.92 bash /out/linux_native.sh linux-arm64
docker run --rm --platform linux/amd64 (same mounts) rust:1.92-slim bash /out/linux_native.sh linux-amd64
python3 determinism/compare.py determinism/mac determinism/linux-arm64 determinism/linux-amd64
nm -u / nm -D -u / file on the three binaries; rg for mul_add / transcendentals / rounding in the snapshot
```

**Caveats**
- amd64 ran under emulation (probably Rosetta), not on real x86 hardware. A real x86_64 Linux CI runner would close that gap.
- Windows and wasm32 have not been tested. See M4.

### 1.2 Spike 5: "WebGL2 fallback works on Linux" (forge-render through the `packages/forge-web` demo, `?backend=webgl2`)

**Verdict: PASS**, on software GL and linux/arm64 only.

**Evidence**
- **Environment.** Headless Chromium 153.0.8010.12 in `mcr.microsoft.com/playwright:v1.63.0-noble` (Ubuntu 24.04, arm64).
- **Build.** The demo was built from the existing `packages/forge-web/pkg` (wasm `b08ccf1a…`, newer than every source file) with the Vite 7.3.6 programmatic API into `$S/webgl2/site`. No repo files were written.
- **GL stacks.** Two were tested: ANGLE→Vulkan→SwiftShader, and ANGLE→GLES→Mesa llvmpipe (LLVM 20.1.2). Both report `MAX_SAMPLES 4`.
- **Checks: 12/12 in each of four runs** (swiftshader-dpr1, auto-dpr1, llvmpipe-dpr1, llvmpipe-dpr2):
  - `backend()==='webgl2'` with MSAA ×4.
  - On `extrude_box`, the centre pick returns `plate/cap:end`, and a real mouse click selects the same face. The corner pick returns `null`.
  - Section on: the grid had 52 hits above z=4 before and 0 after, with 50 cap pixels at z ∈ [3.9968, 4.0013]. The centre pick then returns kind `section` at z=4.0000.
  - Section off restores the geometry.
  - `runBench()` completes 20 edits on the 25-feature fixture, and the fixture's centre pick returns `base/cap:end`.
- **Real fallback.** With `?backend=auto`, `navigator.gpu` exists but `requestAdapter()` returns null, so the viewport picks `webgl2` and passes 12/12.
- **Console.** The only message was Chrome's harmless `No available adapters.`. There were no errors and no page errors. Screenshots were checked by eye: faces, edges, silhouettes, grid, gizmo, selection tint and hatched section caps all render correctly.
- **Timing.** The CPU side matches macOS: loadIr ≈ 42 ms (eval 26, tess 15, upload 1.3). Median edit latency:
  - SwiftShader: 310–511 ms.
  - llvmpipe at 1280×800: 83 ms.
  - llvmpipe at 2560×1600: 149 ms.

  Software rasterization accounts for the difference.

**Commands**
```
node $S/webgl2/build-demo.mjs $S/webgl2/site
docker pull --platform linux/arm64 mcr.microsoft.com/playwright:v1.63.0-noble
docker run --rm --platform linux/arm64 --init --ipc=host --read-only --tmpfs /tmp:rw,exec,size=1g --tmpfs /root:rw,size=256m \
  -v $S/webgl2:/work -v $S/webgl2/site:/site:ro -v <repo>/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core:/pw/playwright-core:ro \
  mcr.microsoft.com/playwright:v1.63.0-noble /work/run.sh test.mjs <swiftshader|llvmpipe|auto|webgpu-noflags|webgpu-unsafe> <1|2>
same … /work/run.sh probe.mjs ; same … /work/run.sh webgpu-probe.mjs
docker desktop restart ; docker rmi mcr.microsoft.com/playwright:v1.63.0-noble
```
Artifacts: `$S/webgl2/out/*.png` and `*.json`, plus the scripts `test.mjs`, `probe.mjs`, `webgpu-probe.mjs`, `serve.mjs` (COOP/COEP) and `run.sh`.

**Caveats**
- Only software GL was tested; there was no hardware GPU. amd64 was not run.
- Median edit latency on SwiftShader is above the 150 ms budget, so a CI latency gate should use llvmpipe (`--use-angle=gl-egl`) or a small canvas.

### 1.3 Other issues seen during verification

These were observed during verification but were not separately triaged, so they carry no severity rating.
- **V1: kernel robustness.** 5 of the 200 s23 revolve programs (`gen_s23_00000`, `00101`, `00116`, `00159`, `00169`) evaluate fine, but `aicad export` exits 3 with `cannot tessellate … revolve side face: refinement stopped after 1025880 points with estimated deviation inf` at the default 0.05 mm deflection. The behaviour is deterministic on every platform, and the error is structured, so the result is not silently wrong.
- **V2: determinism hygiene.** `deg % 360.0` at `forge-core/src/math.rs:138` resolves to the platform `fmod` on macOS and to the compiler-builtins version on Linux. fmod is exact, so the results are identical, but this is the one place that departs from the rule "transcendentals via portable libm". Folded into L2.
- **V3: WebGPU robustness.** This only happens with unsafe flags. On Chromium's SwiftShader WebGPU adapter (`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`):
  - The canvas stays blank, and `pick()` throws `mapping the pick buffer failed`.
  - After a WebGL2 context was created on the same page, `create_buffer_init` (`forge-render/src/viewport.rs:806`) panicked in `wgpu-30.0.1/src/backend/webgpu.rs:2461` with a mappedAtCreation `RangeError`. The panic aborted the whole WASM module (`unreachable`), engine included, instead of returning a structured error.
  - With these flags, `auto` picks the broken adapter and does not fall back to WebGL2.
- **V4.** When viewport creation fails, the demo shows only the message. Nobody verified that the error carries the `RENDER_NO_ADAPTER` code.
- **Environment.** The host disk is close to full (`/System/Volumes/Data` at 100%; free space moved between 123 MiB and 6.3 GB).
  - Docker's containerd returned I/O errors; `docker desktop restart` recovered it.
  - The verifier's images and volume were removed afterwards. The `rust:1.92` image disappeared on its own, not through the verifier.
  - Concurrent cargo builds may fail with ENOSPC.

---

## 2. Confirmed findings

### High

**H1. Revolves within ≈4e-7° of 360° silently drop any face that runs from the axis to the axis. Volume, area and centroid come out wrong, and the result is reported `ok`.**
- **Where.** `forge/crates/forge-check/src/domain.rs:246` (`face_domain`, `period_shift`, `same_point`). Originally critical; votes C/H/H.
- **Evidence.**
  - A sketch on the XZ plane (a half-circle pocket arc (0,10)→(0,0), plus lines closing an 8×22 profile), revolved by `359.9999999°`, gives vol 4423.36 and area 1781.42 with status ok and valid true. The oracle gives 3899.76 and 2095.58, and the analytic value is π·64·22 − 4/3·π·125 = 3899.76: Forge reports +13.4% volume and −15% area.
  - The trigger band matches the threshold exactly: 359.9999996° is wrong, 359.9999995° is right.
  - `math.degrees(6.283185307)` hits it too.
  - `oracle diff` flags POTENTIAL_SILENT_WRONG for pocket, lemon and apple variants.
  - The exported mesh is correct (vol 3880.52), so the mesh and the metrics disagree.
  - At very small angles (1e-7°) the volume is 5% high. That is inside the SPEC absolute tolerance, so the diff reports MATCH.
  - Repro files: `$S/audit-swg/ir/pocket_*.json` and `$S/audit-swg/cases/`.
- **Fix.**
  - Never apply `period_shift` at a join whose previous end lies on a singular line (S_u = 0: pole, apex, spindle point, horn centre). Add an explicit gap segment in the direction the face orientation requires, reusing forge-mesh's `jump_sign`/`continuation_shift` rule.
  - Don't let `same_point` swallow a gap along a singular line: compare in 3D or with an absolute parameter epsilon.
  - Add a per-face check that the domain area ∬|n| is positive (see M1).
  - Add the repro files as oracle cases.

**H2. The tight bbox includes torus critical points beyond the singular line on 360° spindle (apple/lemon) and horn faces. The box is up to 9× too large.**
- **Where.** `forge/crates/forge-check/src/domain.rs:361`, `bbox.rs:162` and `bbox.rs:213`. Votes H/H/H.
- **Evidence.**
  - A lemon profile (arc (0,−6)→(2,0), centre (−8,0), plus a top line and the axis line) revolved 360° gives a Forge bbox of `[-2,-2,-10]..[8,2,0]`. The oracle gives `[-2,-2,-6]..[2,2,0]`. The volume 41.4662363 is identical in both.
  - Horn: Forge `[-8,-8,-4]..[8,8,4]`, oracle `[-4,-4,-4]..[4,4,0]`.
  - Upward lemon: Forge `±18`, oracle `±2`.
  - Every plane tested (XZ, XY, two tilted frames) gives POTENTIAL_SILENT_WRONG.
  - Mechanism in the code:
    - `contains()` falls back to `dom.winding_u() > 0` when the ray finds no ring crossing.
    - `v_candidates` wraps v into `[mid−π, mid+π)` instead of rejecting values outside `spindle_v_range()`.
- **Fix.**
  - For faces whose domain reaches a singular line (winding_u ≠ 0), limit critical-point candidates to the v-interval between the ring and the v* the mass code already picks.
  - Always reject v outside `spindle_v_range()` instead of wrapping it. Alternatively, add a virtual boundary piece along v* in `contains()`.
  - Add oracle cases: 360° spindle and horn arcs from the axis to an off-axis point.

**H3. The CI "Forge vs OCCT" diff job never builds or runs Forge, so it compares OCCT with OCCT-written goldens.**
- **Where.** `.github/workflows/ci.yml:32`. Originally critical; votes H/H.
- **Evidence.**
  - ci.yml:22-32 has no `cargo build -p forge-cli` and downloads no artifact, and `needs: forge` does not share `target/`. So `../forge/target/debug/aicad` is missing.
  - In that case `oracle/src/aicad_oracle/cli.py:116-119` prints a WARNING and falls back to `corpus/golden/*.metrics.json`, whose `"engine"` field is `occt 7.9.3 …`.
  - cli.py:146-148 passes on ROBUSTNESS and NO_REFERENCE unless `--fail-on-robustness` is given, and CI does not give it.
  - This job is the release gate for principle 2. See also M6 and M9.
- **Fix.**
  - Add `cargo build -p forge-cli` (working-directory `forge`) before the diff, or pass `aicad` as an artifact from the forge job.
  - Make `oracle diff` exit 2 when an explicitly given `--forge-bin` is missing.
  - Pass `--fail-on-robustness` and treat NO_REFERENCE as a failure.
  - Update the oracle README, which still says the fallback happens "until `aicad` exists".

### Medium

**M1. `validate()` checks only the total signed volume, so a face that contributes zero or has the wrong sign passes.**
- **Where.** `forge/crates/forge-check/src/lib.rs:307` (lines 295-313). Votes M/M/M.
- **Evidence.** The H1 IR passes `forge_check::validate` with no Error issues: the sphere face integrates to 0, and the report says ok/valid. A mis-oriented cavity shell would likewise give V_outer + V_cavity. The risk grows with the v1 booleans being built now.
- **Fix.**
  - Per face: ∬|n| du dv must be > 0, with the sign implied by `face.sense` and the loop orientation.
  - Per shell: the enclosing shell must have V > 0 and nested cavity shells V < 0, decided by a nesting or point-in-shell test.
  - Report each failure as its own `FORGE_*` issue.

**M2. `canonical_axis` uses an unnamed 1e-9 sign threshold that conflicts with `SUPPORT_ANGLE_TOL` (1e-7), so carriers that are equal within tolerance compare as opposite.**
- **Where.** `forge/crates/forge-naming/src/fingerprint.rs:292`, which is used at lines 318, 331, 346, 360 and 372. Votes L/M.
- **Evidence.** For d1=normalize(4e-8, 0.6, 0.8) and d2=normalize(−4e-8, 0.6, 0.8), the raw angle is 8e-8 ≤ 1e-7. After canonicalization the angle is ≈π and s_support=0. `compare()` then returns 0, and the resolver drops the true match (Missing or Renamed).
- **Fix.** Compare unoriented carriers (cylinder, cone, torus, line and circle axes) sign-independently with `min(ang(a,b), π−ang(a,b))`. If canonicalization stays, derive its threshold from `SUPPORT_ANGLE_TOL` and try both signs in `support_gap`.

**M3. CI has no TypeScript or oracle-pytest job, `ci.yml` has not changed since the first commit, and CI has never run.**
- **Where.** `.github/workflows/ci.yml:6`. Originally high; votes M/M/M.
- **Evidence.**
  - `git log -- ci.yml` shows only `3beca0b`, and `git remote -v` is empty.
  - Documented guarantees that CI does not run:
    - `cadscript/test/diagnostics.test.ts:252`: every diagnostic code has a test.
    - `agent-tools/test/playbooks.test.ts:22`: playbooks cover every SPEC code.
    - `evals/test/reference.test.ts:40`: pass@1 = 1.
    - The forge-web smoke test.
    - Desktop e2e.
    - 86 oracle `def test_` functions, including the three OCCT-defect pins (`test_eval.py:232/318/341`).
  - Spike 06's "300 cases per property in CI" is false.
- **Fix.**
  - Add a `ts` job: pnpm, Node 22, `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test`, with `CADSCRIPT_FC_RUNS` pinned.
  - Add `uv run pytest` to the oracle job.
  - Push to a remote with Actions enabled. Until then, no "CI-verified" claim holds.

**M4. Nothing tests the native-vs-wasm32 bit-identity claim; CI only builds wasm32.**
- **Where.** `docs/FORGE.md:107`. Originally high; votes M/M/H.
- **Evidence.**
  - ci.yml:20 runs only `cargo build --target wasm32-unknown-unknown`.
  - There is no `.cargo/config.toml` runner, no wasm-bindgen-test and no wasmtime step.
  - `packages/forge-web/test/engine.test.mjs:67-74` compares wasm with wasm, not with native goldens, and it is not in CI either.
  - Spike 01 (line 39) and `forge-mesh/src/lib.rs:50-51` claim that native and wasm32 agree.
  - Clippy is never run for wasm32.
  - Together with §1.1, spike 1 is still open for wasm32.
- **Fix.**
  - `rustup target add wasm32-wasip1`, then `CARGO_TARGET_WASM32_WASIP1_RUNNER=wasmtime cargo test --target wasm32-wasip1 -p forge-core --test determinism_golden -p forge-mesh -p forge-io`.
  - Add `cargo clippy --target wasm32-unknown-unknown -p forge-render -p forge-wasm -- -D warnings`.

**M5. No golden hashes pin forge-solve or end-to-end regen output across targets.**
- **Where.** `docs/spikes/04-sketch-solver.md:151`. Originally high; votes M/M/M.
- **Evidence.**
  - `39ec20a99e9b8750` appears only in the doc.
  - `forge-solve/tests/properties.rs:139-142` and `forge-regen/tests/regen.rs:100-111` only check repeatability within one process.
  - GOLDEN constants exist only for forge-core, forge-mesh and forge-io.
  - So the 3-OS matrix could not detect a solver, forge-ops or mass-property divergence. (§1.1 compared the regen outputs once, by hand, and they matched.)
- **Fix.**
  - Add `forge-solve/tests/determinism_golden.rs`: FNV-hash `generate::corpus(2026, 1000)` and assert `== 0x39ec_20a9_9e9b_8750`.
  - Add a forge-regen golden that hashes the canonical report JSON over `corpus/programs`, following the forge-core pattern.

**M6. The only Forge-vs-OCCT comparison inside `cargo test` can pass after comparing zero reports.**
- **Where.** `forge/crates/forge-regen/tests/regen.rs:204`. Votes M/M/M.
- **Evidence.**
  - Lines 196-199 return early when `corpus/golden` is absent.
  - Lines 204-216 `continue` on a read or deserialize failure.
  - Lines 234-235 never assert anything about `compared`.
  - forge-ir report types are being extended to v1 right now. If all 8 goldens stop parsing, the test still passes.
- **Fix.**
  - Assert `compared == program_names().len()`.
  - Treat a golden that fails to parse as a problem, not a skip.
  - Panic when `corpus/golden` is missing and `CI` is set.

**M7. The renderer tests behind spike 05's picking, section and silhouette claims pass without a GPU.**
- **Where.** `forge/crates/forge-render/tests/offscreen.rs:47`. Votes M/L.
- **Evidence.** Every test at lines 142, 271, 310 and 338 starts with `let Some(ctx) = context() else { return };`. ci.yml:19 never sets `FORGE_RENDER_REQUIRE_GPU=1`, and ubuntu-latest has no Vulkan or EGL driver. There is no Linux WebGL2 job either; §1.2 was a manual run.
- **Fix.**
  - On the ubuntu leg, `sudo apt-get install -y mesa-vulkan-drivers` (lavapipe) and set `FORGE_RENDER_REQUIRE_GPU=1` for `cargo test -p forge-render`.
  - Add a headless-Chromium WebGL2 job based on `$S/webgl2/test.mjs`, using llvmpipe.

**M8. The SPEC code `SKETCH_DEGENERATE_LOOP` [R-5] is never exercised by the oracle or the differential.**
- **Where.** `oracle/src/aicad_oracle/invalidgen.py:18`. Votes M/L.
- **Evidence.**
  - No oracle test references it.
  - invalidgen has no kind that produces it (lines 15-20).
  - The only Forge coverage is the private-helper unit test at `forge-ops/src/sketch/mod.rs:649-653`.
  - So spike 01's "210/210 error-corpus MATCH" says nothing about R-5.
- **Fix.**
  - Add a `degenerate_loop` kind to invalidgen with areas at exactly tol² and just above.
  - Add an oracle pytest case.
  - Add a forge-regen test expecting `SKETCH_DEGENERATE_LOOP` plus `DEPENDENCY_FAILED` on the consuming extrude.

**M9. The headline oracle-agreement numbers in spikes 01 and 08 are one-off local runs that no CI job reproduces.**
- **Where.** `docs/spikes/01-forge-f0-oracle.md:37`. Votes M/M/M.
- **Evidence.**
  - "6,008/6,008 MATCH; 210/210 error-corpus" and "61 MakerBench tasks passing on native Forge" are not automated anywhere.
  - `corpus/generated` is gitignored and has 0 tracked files.
  - `packages/evals/test/real-engine.test.ts:18` is `describe.skipIf(!engine)`.
  - The default suite replays oracle-recorded fixtures.
  - The nightly differential is still a follow-up (spike 01, line 60).
- **Fix.** Add a nightly workflow:
  - Build forge-cli.
  - `uv run oracle gen --count 1000 --seed $GITHUB_RUN_NUMBER`.
  - `uv run oracle diff … --forge-bin … --fail-on-robustness`, including `invalid/`.
  - `AICAD_EVALS_REAL_ENGINE=forge pnpm --filter @aicad/evals test real-engine`.

**M10. The license gates that CLAUDE.md principle 5, LICENSING.md and ADRs 0000/0001 say CI runs (cargo deny and a JS license check) do not exist.**
This merges two findings: license-compliance `ci.yml:6` (originally high; votes M/M/M) and verification-gaps `CLAUDE.md:27` (votes M/L/M).
- **Evidence.**
  - The claims: CLAUDE.md:27, LICENSING.md:22, ADR 0000:66, ADR 0001:50 and FORGE.md:181.
  - There is no `deny.toml` anywhere.
  - ci.yml:17-20 runs only fmt, clippy, test and the wasm build.
  - The root devDependencies are only `turbo` and `typescript`.
  - The dependency trees are clean today (158 shipped crates, all production JS deps), but nothing stops a transitive GPL or LGPL dependency.
  - LGPL `@salusoft89/planegcs` and GPL `python-solvespace` tooling sits in `forge/crates/forge-solve/oracle/`, outside `oracle/`, with nothing enforcing that boundary.
- **Fix.**
  - Add `forge/deny.toml`. Allow MIT, Apache-2.0, BSD-2/3, ISC, Zlib, 0BSD, Unlicense, Unicode-3.0 and MPL-2.0; deny GPL, LGPL and AGPL.
  - Run `cargo deny check licenses bans` for forge-wasm, forge-cli and forge-render (for example with `EmbarkStudios/cargo-deny-action`).
  - Add a JS job: `pnpm licenses list --prod --json` for each shipped package, following workspace deps transitively and excluding the declared oracle paths.
  - Add a path ban-check that OCP, build123d, planegcs and solvespace appear only under `oracle/` or `*/oracle/`.
  - Move the solver oracles under `oracle/`, or amend ADR 0000 to list that path.

**M11. The shipped web bundle strips the MIT and MPL notices from react, react-dom, scheduler, zod, marked and DOMPurify, and no third-party notices file ships.**
- **Where.** `packages/desktop/electron-builder.config.cjs:18`. Votes M/L.
- **Evidence.**
  - `grep -c '@license'` on `dist/web/assets/index-*.js` gives 0, and `Meta Platforms` also gives 0.
  - DOMPurify is inside `editor.api-*.js`, but its header is gone.
  - Only TypeScript's `/*!` header survives.
  - Monaco's ThirdPartyNotices.txt and TypeScript's ThirdPartyNoticeText.txt are not shipped.
  - The planned esbuild bundling of the agent worker would drop further LICENSE files.
- **Fix.**
  - Add `rollup-plugin-license` in `packages/app/vite.config.ts` `build.rollupOptions.plugins` to emit `dist/web/THIRD_PARTY_NOTICES.txt`, including the Monaco and TypeScript notice files.
  - Ship that file and show it in About → Licenses.
  - Apply the same plugin to the future worker bundle.

**M12. `patchSource` deletes or replaces code beyond the targeted feature, and apply then reports OK.**
- **Where.** `packages/agent-tools/src/source.ts:145`. Originally high; votes H/M/M.
- **Evidence.**
  - A delete cuts to `endOfLine(text, target.end)`, which removes other statements on the same line. `r4-tools.mjs`: features before `s,old,e`, after `s`.
  - A replace uses the statement span from TypeScript's error recovery. `syntaxErrors` (line 93) is computed but never read.
  - `r11-patch-e2e.mjs`: a truncated patch followed by the natural fix gives `changes: −e, −f, −t`, with status `proposed` and verified true.
  - Scripts are in `$S/audit-csa/`.
- **Fix.**
  - End a delete at the statement end plus trailing trivia (reuse cadscript `trivia.endOfStatementLine`).
  - Return a PatchError when the file has syntax errors and the target span covers more than one statement.
  - After patching, re-locate statements and reject the patch if any feature other than the targeted or new ones disappeared.

**M13. The designer-callable `rollback` tool resets the failure counters, which defeats the `same_error` and `repairs_exhausted` stop rules.**
- **Where.** `packages/agent/src/agent.ts:489`. Originally high; votes M/M/M.
- **Evidence.** Lines 488-491 reset `#failedStreak` and `#lastFailSig` on every rollback tool call. `r5-agent.mjs rollbackloop`: 12× [same failing apply, rollback] followed by propose gives status proposed with 12 failedApplies and 0 replans. The control without rollback gives `stopped/same_error` after 2 turns.
- **Fix.** Reset the counters only on an orchestrator REPLAN. Track every failure signature seen in the task, and cap total failed applies per task.

**M14. `apply_cadscript` with `source` plus `patches: []` silently discards the new source and reports OK.**
- **Where.** `packages/agent-tools/src/tools.ts:189`. Votes M/M/M.
- **Evidence.**
  - The exclusivity check treats `[]` as absent, but `if (patches)` is still truthy (lines 189-197).
  - `r16-apply-input.mjs`: `apply #1: OK`, and the session source is not the new one.
  - The zod schemas are non-strict, so unknown keys are stripped, e.g. `get_code({name})` succeeds, even though the advertised schema says `additionalProperties:false`.
- **Fix.**
  - Use `patches?.length` in both the check and the branch.
  - Return `bad_input` when both `source` and `patches` are present.
  - Build tool inputs with `z.strictObject`.

**M15. The implicit proposal after nudges bypasses the spec-test REFINE gate and leaves failing tests out of `known_issues`.**
- **Where.** `packages/agent/src/agent.ts:403`. Votes M/L/M.
- **Evidence.**
  - `r5-agent.mjs implicit`: status proposed, 0 refines, `two_bodies:FAIL`, and the failure is missing from known_issues. The explicit path runs 2 refines and records it.
  - Related (lines 569-575): a second `propose` with nothing ever verified returns `{"status":"proposed","verified":false}` (`r6-propose.mjs S4`).
- **Fix.**
  - Send the implicit path through `#onPropose`, or at least run the tests and record failures.
  - End as `stopped/no_progress` when tests fail.
  - Never report `proposed` for an unverified model.

**M16. A failing spec test counts as "acknowledged" when any known_issue merely contains the test id as a substring.**
- **Where.** `packages/agent/src/agent.ts:579`. Votes M/M/M.
- **Evidence.** `r5-agent.mjs substring`: the known_issue "Hole sizes were not specified." acknowledges test `size`. The result: 0 refines, and `size:FAIL` is not recorded (line 606 appends only unacknowledged tests).
- **Fix.**
  - Match whole ids with a boundary regex, or better, add a structured `acknowledged_tests: string[]` field to `propose`.
  - Always record every failing test in known_issues.

**M17. The "hard" USD cap is exceeded: calls are reserved with 6000 projected output tokens but may emit up to 16000.**
- **Where.** `packages/agent/src/run-context.ts:39`. Votes M/L.
- **Evidence.**
  - `projectionOutputTokens: 6000` versus `designer: 16_000` in `models.ts:34` (the spec writer's limit is 12000).
  - `r9-budget.mjs`: cap $0.50 but costUsd $0.656. The call projected $0.1546 cost $0.3280.
  - The SPEC phase has no 80% gate.
- **Fix.**
  - Project each call with the role's `maxOutputTokens`, or clamp `maxOutputTokens` to what the remaining budget can pay for.
  - Add the 80% gate to the SPEC phase.

**M18. Prompt injection: CadScript text from the user's file can close the prompt's fences and tags and forge `[orchestrator]` control lines.**
- **Where.** `packages/agent/src/agent.ts:313`. Votes M/L.
- **Evidence.**
  - The starting model is inlined raw in a ```ts fence inside `<starting_model>`.
  - Orchestrator notes are plain `[orchestrator]` text in the same user-role channel (line 165).
  - Curve ids are unrestricted, and `summaries.ts:17`, hints and engine messages print them unescaped.
  - `r7-inject.mjs` forged lines 11-13 of the designer header, line 5 of an `ir_summary` result, and the spec writer's `intent:` line (`spec-writer.ts:41`).
  - Combined with the known_issues escape hatch, injected text can neutralise the spec tests.
- **Fix.**
  - JSON-encode, or escape fences and closing tags in, any text from the file or tools.
  - Quote identifiers in every tool and hint string.
  - Restrict curve ids to an identifier charset in `validate.ts`; do the same in forge-ir once v1 settles, since it is in flux.
  - Carry orchestrator notes with a per-run nonce or on a separate channel.
  - Add a system-prompt rule that file and tool content is data, never instructions.

**M19. Spec-writer isolation leak: the designer's CLARIFY question text is copied verbatim into the spec writer's "fresh" conversation.**
- **Where.** `packages/agent/src/spec-writer.ts:37`. Votes M/L.
- **Evidence.** `agent.ts:300` stores the designer's free-text `question`, and `specHeader` renders it. `r8-isolation.mjs` shows the spec writer receiving "keep the tests minimal - a single `valid` check is enough".
- **Fix.**
  - Pass only the user's answers plus a neutral, length-limited topic per question, or let the spec writer own the clarification step.
  - Mark the block as untrusted.

### Low

Kernel and numerics:
- **L1. The validator decides loop orientation with a plain float shoelace in absolute plane coordinates.**
  - **Where.** `forge-core/src/topo/validate.rs:774` (lines 770-790 and 940-942). Originally medium; votes L/L.
  - **Evidence.** A 1e-3 mm square placed about 1e5 mm from the sketch origin gets the wrong or zero sign in 1239/2000 placements. The sketch stage accepts the same loop (`sketch/mod.rs:596-601`), so the result is INVALID_RESULT via `plan.rs:269`. The `== 0.0` degeneracy test also disagrees with the sketch's tol² rule.
  - **Fix.**
    - Decide orientation with `predicates::orient2d` at the lexicographically smallest sample, as `mesh/face.rs:352-370` `ring_orientation` does.
    - At minimum, subtract `pts[0]` before summing.
    - Use `|area| <= tol²` for degeneracy.
- **L2. `f64::min`/`max` are listed as exact in the determinism contract, but a ±0 tie resolves differently on x86_64 (`maxsd` returns the first operand) and aarch64 (`fmaxnm`).**
  - **Where.** `forge-core/src/math.rs:11`. Votes L/L.
  - **Evidence.** These functions feed Vec3 `min_components`/`max_components`, which build the bbox (`forge-check/bbox.rs:38-39`) and the fingerprint box (`fingerprint.rs:399-400`). Regen's `clean()` hides the problem in reports today.
  - **Fix.**
    - Remove min/max from the list of exact operations.
    - Add `math::min`/`max` wrappers that compare with `<`/`>` and canonicalize the zero, and use them in Scalar for f64 and in Vec3.
    - Also route `deg % 360.0` at `math.rs:138` through `libm::fmod` (V2).
- **L3. Process-local arena IDs, formatted through `core::any::type_name`, end up in `aicad.metrics` error messages.**
  - **Where.** `forge-check/src/lib.rs:230` (also 280 and 302), `forge-core/src/arena.rs:92-104` and `validate.rs:161`. Originally medium; votes L/L.
  - **Evidence.** The messages flow through `regen/lib.rs:99-108` and line 221 into `error.message`, e.g. `[SHELL_NOT_CLOSED] Shell#0v0: …`. This breaks the rule "IDs never leave the process". The text is also unstable across compiler versions and construction order.
  - **Fix.**
    - Map every EntityRef, shells included, to a provenance or ordinal name before it leaves the kernel.
    - Keep `{:?}` of ids for in-process logs only.
- **L4. `SHELL_ZERO_VOLUME` uses the magic epsilon `1e-12·A^1.5`.**
  - **Where.** `forge-check/src/lib.rs:299`. Votes L/L.
  - **Evidence.** The same kind of raw threshold appears at `mass.rs:182` (1e-9), `domain.rs:333` (1e-9, in parameter radians) and `domain.rs:351` (±1e-12).
  - **Fix.** Use named, documented constants, or derive them from `Tolerance` (e.g. V ≤ linear_tol·A, parameter thresholds = linear_tol / radius).
- **L5. Constraint-solver conflict and redundancy circuits are chosen with unnamed epsilons that bypass `SolveOptions`.**
  - **Where.** `forge-solve/src/analysis.rs:135`: pivot `1e-9` at line 135, support `1e-8·max` at line 169. Votes L/L.
  - **Evidence.** These drive OverConstrainedRedundant (`solver.rs:262`), the conflict sets (lines 370-376) and the redundancy reports (lines 577-590). The factors at `solver.rs:788-789` are unexplained too.
  - **Fix.** Add named `circuit_pivot_tolerance` and `circuit_support_tolerance` fields to `SolveOptions`, or derive them from `rank_tolerance`/`conflict_rank_tolerance`, and pass them into `analyze()`/`circuits()`.
- **L6. SPEC R-12 ("never report an invalid body as ok") is not tested in Forge or by the diff.**
  - **Where.** `forge-regen/src/lib.rs:99`. Votes M/L/L.
  - **Evidence.**
    - No test in `forge/crates/*/tests` mentions INVALID_RESULT, FORGE_INTERNAL or InvalidResult.
    - `compare.py:169-170` only adds a note when `valid != true`.
    - `FORGE.md:120-124` claims validity is an exact-match field, which contradicts R-13.
  - **Fix.**
    - Add a `#[cfg(test)]` test that feeds `checked()` a deliberately broken Body and expects `INVALID_RESULT`.
    - Have compare.py classify `ok` with `valid != true` as ROBUSTNESS or SILENT_WRONG.
    - Fix `FORGE.md:124`.

Verification:
- **L7. Spike 04's solver agreement with PlaneGCS and SolveSpace and its ≤4 ms WASM drag budget are not in CI.**
  - **Where.** `docs/spikes/04-sketch-solver.md:143`. Votes L/L/L.
  - **Evidence.** These were manual runs (lines 127-134), and wiring them into CI is still an open follow-up (lines 255-257).
  - **Fix.** Add a nightly job:
    - Run the `oracle_corpus` example.
    - Run `planegcs_oracle.mjs` and `solvespace_oracle.py`, failing below the reported rates.
    - Run `wasm_bench.mjs` on wasm32-wasip1, failing if the max frame exceeds 4 ms (with headroom for runner noise).

Electron security:
- **L8. No Electron fuses and the default entitlements: any same-user process can run code as the signed `aicad` binary and decrypt keychain-protected API keys.**
  - **Where.** `packages/desktop/electron-builder.config.cjs:27`. Originally medium; votes M/L/L.
  - **Evidence.**
    - The config has no `electronFuses` and no `entitlements`, so the default template applies, and it includes `disable-library-validation`.
    - Exploit: `kill -USR1 $(pgrep -x aicad)`, or `--inspect-brk`, then a CDP `safeStorage.decryptString(…agent-keys.json…)` returns the plaintext key without a Keychain prompt.
    - On Windows the install is per-user, and `app-web` ships as loose files.
  - **Fix.**
    - Add `electronFuses` with runAsNode, NodeOptions and NodeCliInspect set to false; embedded asar integrity, onlyLoadAppFromAsar and cookie encryption set to true; and grantFileProtocolExtraPrivileges set to false.
    - Supply an explicit mac entitlements file without `disable-library-validation`.
    - Put `app-web` inside the asar, or hash-verify it.
    - Consider a perMachine install on Windows.
- **L9. The agent worker inherits `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`, so the SDKs send keys from Settings to whatever endpoint the environment names.**
  - **Where.** `packages/desktop/src/agent/keys.ts:84`. Originally medium; votes L/L.
  - **Evidence.** The suffix denylist keeps `*_BASE_URL`, `AWS_ACCESS_KEY_ID` and `OPENAI_API_KEY_2`. `runner.ts:169` passes no baseURL, and the SDK constructors read it from the environment. `launchctl setenv` is enough to redirect the key.
  - **Fix.**
    - Pass explicit official base URLs in `buildGateway`.
    - Build the worker environment from an allowlist (PATH, HOME, TMPDIR, LANG, SystemRoot, …).
- **L10. Packaged builds obey dev and test environment overrides; with `AICAD_DEV_URL` set, any remote origin loads with the full preload bridge and trusted IPC.**
  - **Where.** `packages/desktop/src/main.ts:29`. Originally medium; votes L/L.
  - **Evidence.**
    - `main.ts:29` and line 188 load `devUrl` with no packaging gate.
    - `AICAD_APP_DIST` (lines 38-39) and `AICAD_BIN` (`forge-cli.ts:44-45`) are read before the `isPackaged` checks.
    - `isTrustedSender` (lines 45-48) is a prefix test, so it also trusts `http://localhost:5173@evil.com/` and `…5173.evil.com`.
  - **Fix.**
    - Read the `AICAD_*` overrides only when `!app.isPackaged`.
    - Compare exact origins with `new URL(...).origin`.
    - Accept only localhost and 127.0.0.1 dev origins.
- **L11. The Forge CLI child process inherits the full main-process environment, provider API keys included.**
  - **Where.** `packages/desktop/src/forge-cli.ts:76`. Votes L/L.
  - **Evidence.** `spawn` is called with no `env`. It runs on every `forge:eval`, and in dev it runs a repo-built binary.
  - **Fix.** Pass `sanitizedEnv(process.env)`, or better a minimal allowlist. Do the same in `@aicad/evals` ForgeCliEngine.
- **L12. The OpenAI-compatible base URL accepts cleartext `http://` for any host.**
  - **Where.** `packages/desktop/src/agent/protocol.ts:137` and `settings.ts:82`. Votes L/L.
  - **Evidence.** `parseBaseUrl("http://api.remote-llm.example/v1")` is accepted, so the bearer key and the design go out unencrypted.
  - **Fix.** Allow `http:` only for loopback hosts (localhost, 127.0.0.0/8, ::1) and require `https:` everywhere else.
- **L13. DevTools and the `window.__aicad.execute` automation API are enabled in packaged builds.**
  - **Where.** `packages/desktop/src/menu.ts:155`. Votes L/L.
  - **Evidence.** `main.ts:125-132` does not set `devTools:false`. `app/src/bootstrap.ts:238-239` exposes `__aicad` with no guard. A social-engineering console paste therefore gets the privileged bridge.
  - **Fix.**
    - Set `webPreferences.devTools: !app.isPackaged` and drop the menu item in packaged builds.
    - Expose `__aicad` only behind `import.meta.env.DEV` or an e2e flag.
- **L14. Path grants are never revoked, are not split into read and write, and are not tied to realpath; `doc:state` paths are not checked.**
  - **Where.** `packages/desktop/src/files.ts:8`. Votes L/L.
  - **Evidence.**
    - `files.ts:11-15` is add-only.
    - The open dialog (`ipc.ts:85`) grants the same right that `fs:write` checks.
    - `recent:clear` (`ipc.ts:124-127`) keeps grants, and `main.ts:224` re-grants recent files at startup.
    - `main.ts:256` and `ipc.ts:175` pass an unchecked `setRepresentedFilename`.
  - **Fix.**
    - Keep separate read and write sets.
    - Revoke grants on `recent:clear`.
    - Compare `fs.realpath` results.
    - Accept a `doc:state` path only if it is already granted.

Licensing:
- **L15. `forge_wasm_bg.wasm` and the `aicad` binary ship about 90–150 third-party Rust crates with no attribution.**
  - **Where.** `packages/forge-web/package.json:26` and `electron-builder.config.cjs:20`. Originally medium; votes L/L.
  - **Evidence.** 87 crates in the wasm tree, including MIT-only (libm, schemars, slab, zmij), Apache-2.0-only (codespan-reporting) and Zlib (foldhash, slotmap). forge-cli adds strsim.
  - **Fix.**
    - Run `cargo about generate` (with accepted licenses that match deny.toml) in `packages/forge-web/scripts/build.mjs` and in the desktop packaging step.
    - Ship THIRD_PARTY_LICENSES next to the wasm and `bin/aicad`, and add it to `files` and `extraResources`.
    - Record the MIT-or-Apache election for dual-licensed crates.
- **L16. `@aicad/llm-gateway` declares Apache-2.0, but LICENSING.md assigns it MPL-2.0.**
  - **Where.** `packages/llm-gateway/package.json:5`. Originally medium; votes L/L/M.
  - **Evidence.** The package is not private. LICENSING.md:8/10 and ADR 0001 do not list it as an exception. `forge-ir` has the same mismatch (Apache-2.0 inside the MPL `forge/` tree), but it was not audited because it is in flux.
  - **Fix.**
    - Decide the intended license, then update either the LICENSING.md:10 and ADR 0001 exception lists or the manifest.
    - Resolve forge-ir the same way.
    - Have the M10 license job assert a path→license map.
- **L17. Publishable npm packages ship no LICENSE file.** This affects @aicad/cadscript, @aicad/llm-gateway, @aicad/forge-web and @aicad/ir-types.
  - **Where.** `packages/cadscript/package.json:23`. Votes L/L.
  - **Evidence.** The `files` lists include no license, and the LICENSE texts exist only at the monorepo root. Apache-2.0 §4(a) requires giving recipients a copy.
  - **Fix.** Add a LICENSE file, or copy one in a prepack script, for each package. Alternatively, set `"private": true` on packages not ready to publish.
- **L18. The packaged desktop app includes neither the MPL-2.0 text nor a source-availability notice.**
  - **Where.** `packages/desktop/electron-builder.config.cjs:16`. Votes L/L.
  - **Evidence.** `files` holds only `dist/**` and `package.json`, and extraResources holds only app-web and bin. MPL §3.2 applies.
  - **Fix.**
    - Add `{ from: "../../LICENSE-MPL-2.0", to: "LICENSE.txt" }` and the generated notices to extraResources.
    - Show the repository URL in About.
- **L19. The dataset-license record that LICENSING.md requires lives in a gitignored directory and does not exist.**
  - **Where.** `.gitignore:22` (`/corpus/external/`). Votes L/L/L.
  - **Evidence.** LICENSING.md:24 requires `corpus/external/SOURCES.md`, but the whole directory is ignored and the file is absent. `forge-io/src/step.rs:31` already plans to use ABC.
  - **Fix.** Change the rule to `/corpus/external/*` plus `!/corpus/external/SOURCES.md`, or move the record to a tracked `corpus/EXTERNAL_SOURCES.md` and update the four docs. Commit it now with an empty table.

Agent and CadScript:
- **L20. The compiler throws `RangeError` instead of a diagnostic on moderately nested input, which fails the whole agent run.**
  - **Where.** `packages/cadscript/src/compile.ts:841`. Originally medium; votes M/L/L.
  - **Evidence.**
    - About 2000 nested parentheses or arrays overflow the TS parser.
    - About 20k left-deep `+` terms overflow `fold()` (lines 240-270).
    - `DesignSession.open` has no catch, so the run ends as `failed/model_error`.
    - Repro: `r1-compile.mjs`, `r5-agent.mjs deepcontext`.
  - **Fix.**
    - Convert the overflow into a `CS_SYNTAX` or new `CS_TOO_COMPLEX` diagnostic.
    - Make `fold` iterative or depth-limited.
    - Catch compile failures in `DesignSession.#evaluate` and treat them as an L0 failure.
- **L21. `compile()` silently accepts and drops `const x;`.**
  - **Where.** `packages/cadscript/src/compile.ts:1156`. Votes L/L.
  - **Evidence.** `if (!init) return undefined; // a syntax error already`. The result is ok:true with the statement dropped; only `typecheck()` reports TS1155.
  - **Fix.** Emit a `CS_STATEMENT_UNSUPPORTED` or `CS_SYNTAX` diagnostic: "a feature const needs an initializer".
- **L22. A second `propose` rolls the session back before the REFINE check without telling the designer or `onDraft`.**
  - **Where.** `packages/agent/src/agent.ts:571`. Votes L/L/L.
  - **Evidence.** `r6-propose.mjs S6`: the REFINE text does not mention the rollback, no rollback draft is emitted, and the live draft still shows the broken version.
  - **Fix.** Call `#emitDraft("rollback")` and prepend a rollback note to the returned text, or roll back only when the proposal is accepted.
- **L23. The REFINE rejection text bypasses the tool-result size cap.**
  - **Where.** `packages/agent/src/agent.ts:588`. Votes L/L.
  - **Evidence.** With 80 tests the text is 12,650 characters, against `MAX_RESULT_CHARS=7000`, with no clip marker. `set_spec_tests` has no max count.
  - **Fix.**
    - Apply `capList(failing, 8, …)` and `clip()`.
    - Enforce `.max(12)` on the tests array, and limit id and description length.

---

## 3. Refuted findings (do not re-raise)

Each of these came from one verifier and was refuted by the pipeline. Where the other verifier found a small hygiene item worth keeping, it is noted as "Residual".

| Finding | Reason refuted |
|---|---|
| CLI `IR_READ_ERROR` embeds OS-specific `io::Error` text (`forge-cli/src/main.rs:249`) | This path runs only when there is no readable input, so no shared input can diverge between platforms. The `code` is stable, and nothing compares message text. Residual: map ErrorKind to fixed text. |
| Naming-harness truth labeller mixes cosine and angle epsilons (`forge-naming/src/harness/truth.rs`) | Each face goes through only one of the two tests. No face that extrude or revolve produces falls in the gap between the thresholds. Mislabels surface as `truth_problems`, and this is test-harness code. Residual: name the constants. |
| `evaluate()`/`regions()` trust unvalidated IR, so declared tolerances loosen the checker (`forge-regen/src/lib.rs`) | It reproduces, but only with hand-built IR that skips validation. Every shipped caller (CLI, wasm, harness) validates first through `from_json`, and the precondition is documented. Revisit when v1 adds producers that build IR in memory. |
| Regen ignores extrude/revolve `regions` and `op` | Both enums have a single variant and use `deny_unknown_fields`, and the v1 `migrate.rs` rejects non-default values. Residual: destructure exhaustively. |
| LGPL/GPL solver oracle harness inside the MPL kernel tree (`forge-solve/oracle/`) | It is private, a devDependency, outside the pnpm workspace, and no crate depends on forge-solve, so nothing shipped can reach it. The path-boundary concern is folded into M10. |
| Shipped `@aicad/evals` and `@aicad/agent` carry an `OracleEngine` that shells out to OCCT | It is only a subprocess launcher, so no OCCT code ships. No desktop path creates it, and it returns ENGINE_UNAVAILABLE without an oracle checkout. |
| Dual-licensed deps have no recorded election (DOMPurify MPL-or-Apache; r-efi …-or-LGPL) | An OR expression needs no recorded election, and both DOMPurify options are acceptable under the policy. r-efi comes in only for UEFI, through the dev-dependency proptest. The attribution gap is covered by M11 and L15. |
| FORGE.md describes fuzzing, Miri, Kani/Verus and Hausdorff as existing | FORGE.md is a forward-looking plan, and its milestones start in Oct 2026. Residual: add "(planned)" labels. |

---

## 4. Recommended fix plan (priority order)

Sizes: **S** is under half a day, **M** is 1–3 days, **L** is more than 3 days.

| # | Item | Findings | Size | Area |
|---|---|---|---|---|
| 1 | Make CI real. Push to a remote with Actions enabled. Make oracle-diff build and run Forge, and fail on a missing `--forge-bin`, on ROBUSTNESS and on NO_REFERENCE. Make the regen golden test assert `compared == N` and treat parse failures as failures. | H3, M6, (M3 remote) | M | `.github/workflows/ci.yml`, `oracle/src/aicad_oracle/cli.py`, `forge/crates/forge-regen/tests/regen.rs` |
| 2 | Fix the near-360° revolve domain join at singular lines. Add the `pocket_*` / lemon / apple repro files as oracle cases. | H1 | M | `forge/crates/forge-check/src/domain.rs` (reuse the forge-mesh continuation rule) |
| 3 | Fix the tight-bbox critical-point candidates on singular-line faces. Add 360° spindle and horn oracle cases. | H2 | M | `forge/crates/forge-check/src/domain.rs`, `bbox.rs` |
| 4 | Strengthen the validity gate. Add per-face area sign and per-shell orientation checks, a `checked()`→INVALID_RESULT unit test, a compare.py rule that `ok` with `valid≠true` fails, and the FORGE.md:124 correction. Land this before the v1 booleans. | M1, L6 | M | `forge-check/src/lib.rs`, `forge-regen/src/lib.rs`, `oracle/.../compare.py`, `docs/FORGE.md` |
| 5 | Add a TS build/test job and oracle pytest to CI. | M3 | S | `.github/workflows/ci.yml` |
| 6 | Enforce licenses. Add `deny.toml` and cargo-deny, a transitive JS license check, an oracle-path ban-check and a manifest→license map. Settle the placement of `forge-solve/oracle` and the llm-gateway and forge-ir licenses. | M10, L16 | M | `forge/deny.toml`, CI, `LICENSING.md`, ADR 0000/0001, `packages/llm-gateway` |
| 7 | Close cross-target determinism coverage. Run the wasm32-wasip1 golden tests under wasmtime, add wasm32 clippy, add forge-solve and forge-regen golden hashes, and confirm the Windows and real x86_64 Linux legs once CI runs. This closes spike 1. | M4, M5, §1.1 caveats | M | `forge/crates/forge-solve/tests`, `forge-regen/tests`, CI |
| 8 | Agent patch safety. Bound delete spans, refuse patches when the file has syntax errors, check that no feature vanished, fix `patches: []`, and use strict zod schemas. | M12, M14 | M | `packages/agent-tools/src/source.ts`, `tools.ts` |
| 9 | Agent stop rules and proposal gates. Stop resetting counters on the rollback tool, send the implicit proposal through `#onPropose`, match whole test ids or add `acknowledged_tests`, emit a draft on rollback, and clip REFINE text. | M13, M15, M16, L22, L23 | M | `packages/agent/src/agent.ts` |
| 10 | Make naming support comparison sign-independent. | M2 | S | `forge/crates/forge-naming/src/fingerprint.rs` |
| 11 | Enforce the budget cap with real projections, and add an 80% gate to the SPEC phase. | M17 | S | `packages/agent/src/run-context.ts`, `models.ts` |
| 12 | Prompt-injection hardening and spec-writer isolation. Use an escaped or JSON envelope, quote identifiers, restrict the curve-id charset (the forge-ir part waits for v1), carry orchestrator notes with a nonce, and send neutral clarification topics to the spec writer. | M18, M19 | M | `packages/agent` (agent.ts, spec-writer.ts, prompts), `packages/agent-tools` summaries/validate |
| 13 | Third-party notices and license texts. Use rollup-plugin-license for the web bundle and cargo-about for the wasm and `aicad`. Add LICENSE files to publishable packages and ship the MPL text plus a source notice in the desktop app. | M11, L15, L17, L18 | M | `packages/app/vite.config.ts`, `packages/forge-web/scripts/build.mjs`, `packages/desktop/electron-builder.config.cjs`, package roots |
| 14 | Renderer CI. Use lavapipe with `FORGE_RENDER_REQUIRE_GPU=1`, and promote the §1.2 headless-Chromium WebGL2 harness (llvmpipe) into CI. | M7 | M | CI, `forge/crates/forge-render/tests`, `packages/forge-web` |
| 15 | Nightly differential. Run `oracle gen` and diff (including `invalid/`), add a `degenerate_loop` invalidgen kind, run the real-engine MakerBench, and run the solver oracles and wasm drag bench. | M8, M9, L7 | L | `.github/workflows/` (nightly), `oracle/src/aicad_oracle/invalidgen.py`, `packages/evals`, `forge/crates/forge-solve/oracle` |
| 16 | Investigate the 5 s23 revolve export failures ("estimated deviation inf") and add them as regression cases. | V1 (unrated) | M | `forge/crates/forge-mesh` (revolve side-face refinement) |
| 17 | Electron hardening. Add fuses and explicit entitlements, gate dev env overrides with exact-origin checks, pin base URLs and use an env allowlist for the worker and the forge-cli spawn, require https for non-loopback hosts, turn off DevTools and gate `__aicad` in packaged builds, and split and revoke path grants. | L8–L14 | M | `packages/desktop/src/*`, `electron-builder.config.cjs`, `packages/app/src/bootstrap.ts`, `packages/evals` ForgeCliEngine |
| 18 | Numerics and tolerance hygiene. Use orient2d in the validator, deterministic min/max wrappers and `libm::fmod`, named tolerances in forge-check and forge-solve, and stable entity names in reports. | L1–L5, V2 | M | `forge-core` (math.rs, topo/validate.rs, arena.rs), `forge-check`, `forge-solve/src/analysis.rs` |
| 19 | CadScript compiler robustness. Emit a diagnostic instead of a stack overflow, make `fold` iterative, and emit a diagnostic for `const x;`. | L20, L21 | S | `packages/cadscript/src/compile.ts`, `packages/agent-tools` DesignSession |
| 20 | WebGPU robustness. Replace `mapped_at_creation` with `queue.write_buffer`, fall back to WebGL2 when WebGPU init or the first render fails, and check the `RENDER_NO_ADAPTER` code. | V3, V4 (unrated) | S | `forge/crates/forge-render/src/viewport.rs:806`, `packages/forge-web` |
| 21 | Track the dataset-license record (`SOURCES.md`). | L19 | S | `.gitignore`, `LICENSING.md`, ADR 0001, FORGE.md, RESEARCH.md |

**Ordering rationale.**
- Items 1–4 address principle 2: they fix the two silent-wrong defects and the gates that should have caught them.
- Items 5–7 make the claims about principles 3–5 true in CI.
- Items 8–12 stop the agent from reporting destroyed or unverified designs as verified.
- The remaining items are attribution, hardening and hygiene.
- Freeing host disk space is an environment task outside this plan, but it will affect items 1, 7 and 14 when run locally.

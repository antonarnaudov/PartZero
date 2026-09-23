# Spike 04: `forge-solve` sketch solver

- **Owner / workstream:** solver agent (Claude Code), main working tree (no git in this workstream)
- **Dates:** 2026-09-23 → 2026-09-23
- **Commit(s):** uncommitted; `forge/crates/forge-solve/`
- **Verdict:** GO

## Goal

Can we own a 2D sketch constraint solver that is fast enough for interactive dragging in
WASM and, above all, *explains* a sketch to an agent — remaining degrees of freedom per
entity, redundant constraints and **minimal** conflicting sets — as well as the reference
open-source solvers do? ([ADR 0008](../adr/0008-own-solvers.md))

Criteria, verbatim from [README.md](README.md):

| Setup | GO when |
|---|---|
| 60–200-entity sketches; 1k generated sketches | <ul><li>≤4 ms per drag frame (WASM).</li><li>DOF counts, redundancy and minimal conflict sets match PlaneGCS/SolveSpace on 1k generated sketches.</li></ul> |

## Setup

**Code (`forge/crates/forge-solve`, MPL-2.0).** Runtime dependencies: `forge-core`,
`serde`, `serde_json`, `thiserror` (all workspace, permissive). No new dependency;
`proptest` is a native-only dev-dependency. No `unsafe`, no LAPACK.

| Module | What |
|---|---|
| `model` | Entities (point, line, circle with radius parameter, arc = center/start/end with a built-in arc rule), `fixed` / `construction` flags; 16 constraint kinds: coincident, horizontal, vertical, parallel, perpendicular, tangent (line–circle, line–arc, circle–circle, circle–arc, arc–arc), equal (length / radius), distance (point–point, point–line), angle, radius, diameter, point-on-line, point-on-circle, midpoint, symmetric (about a line), fix. Dimensions take `driving: false` (reference, measured only). Stable string ids; serde JSON. |
| `system` | Validation with structured error codes, scalar quantities, residuals written once generically over `forge_core::Scalar`; Jacobians by forward-mode AD (`forge_core::Dual`). |
| `solver` | Decomposition, full solve + diagnostics, drag frames, result assembly. |
| `problem` / `sparse` | Levenberg–Marquardt in equation space; minimum-degree sparse Cholesky. |
| `analysis` / `dense` | Rank analysis: Householder QR with column pivoting (production) and one-sided Jacobi SVD (cross-check). |
| `explain` | Sentences that name ids. |
| `generate` | Deterministic sketch generators (tests, benchmarks, oracle corpus). |
| `json` | `solve_json` / `drag_json`: JSON in, JSON out, `{"error": {"code", "message", "details"}}` on bad input. |

**Algorithms.**
- **Formulation.** Every residual is in mm. Angular conditions (parallel, perpendicular,
  angle) are sin/cos/angle errors times a *constant* length taken from the input geometry
  (scaling by the current lengths would let a sketch "satisfy" an angle by collapsing a
  line — found and fixed during the spike). Tangency at a **joint** (a line or arc sharing
  an endpoint with an arc, directly or through coincident constraints) uses the regular
  form "radius ⟂ line at the joint" / "radii collinear at the joint"; the distance form
  (`dist(center, line) = r`) is kept for tangency away from endpoints. At a joint the
  distance form is a double root (the residual is ≤ 0 on the feasible set with maximum
  0 at tangency), which made the Jacobian singular at the solution.
- **Decomposition.** Union–find over unknowns linked by an equation → independent
  clusters, numbered by their first unknown. A full solve handles each cluster; a drag
  re-solves only the cluster(s) containing the dragged point. (No DR-planning yet.)
- **Solver.** Levenberg–Marquardt with weighted minimum-norm steps
  `δ = −W⁻¹Jᵀ(JW⁻¹Jᵀ + μI)⁻¹F`, which is exactly the classical `(JᵀJ + μW)δ = −JᵀF`
  step, so the gain ratio is consistent (an earlier equation-weighted damping gave
  negative predicted reductions and stalled — fixed). Nielsen λ update. The `m × m`
  system is factored by a sparse Cholesky whose pattern comes from an explicit
  minimum-degree elimination (cached per cluster); hubs of dimensions measured from one
  corner stay compact cliques. Under-constrained sketches move as little as possible
  from where they were drawn.
- **Drag.** The dragged point jumps to the cursor and gets weight 10⁶ (others 1); the
  weighted minimum-norm LM then restores the constraints moving everything else
  minimally and the dragged point only when it must. A frame that cannot converge is
  rejected and nothing moves.
- **Rank analysis.** At the solution, the Jacobian rows are normalized to unit length and
  `J_sᵀ` is factored by QRCP (tolerance 1e-8 relative): rank → DOF; right null space →
  per-entity DOF (rank of the entity's block of the orthonormal motion basis) and, for
  points with one DOF, the free direction; left null space → dependencies. The dependency
  basis is reduced to echelon form pivoting on the **latest** equation first, so each
  redundancy names the most recently added constraint and exactly the earlier
  constraints that imply it (a fundamental circuit), and partial redundancy (1 of 2
  equations) is reported as such.
- **Conflicts.** A cluster that does not converge is analyzed at its least-squares point;
  dependencies with a non-zero residual component (`yᵀF ≠ 0`) seed a **deletion filter**
  that removes, earliest first, every member whose removal still leaves a provably
  inconsistent set. Consistency verdicts are three-valued — *consistent* (LM converges),
  *inconsistent* (LM stalls at a non-zero least-squares minimum), *unknown* (budget
  exhausted while still descending) — and a conflict is only claimed on *inconsistent*
  evidence; `verified_minimal` says whether every one-smaller subset was proven
  solvable. Several independent conflicts are found by removing each set's suggested
  (latest) constraint and repeating. Conflicting clusters keep their input geometry.
- **Status:** `under_constrained`, `fully_constrained`, `over_constrained_redundant`,
  `conflict`, `failed_to_converge`, plus `ok` (every driving constraint holds to 1e-10 mm).

**API.** `solve(&Sketch, &SolveOptions) -> Result<SolveResult, SketchError>` (errors only
for invalid input; every solver outcome is in the result); `Solver::new` + `solve()` +
`drag(point, [x, y])` for interactive use; `drag(sketch, point, targets, opts)`;
`solve_json` / `drag_json`. The result has per-entity `dof`, `free_direction`,
`radius_free`; per-constraint `state` (satisfied / redundant / partially_redundant /
conflicting / unsatisfied / reference), `residual`, `measured`; `redundant[]` with
`implied_by`; `conflicts[]` with `suggested_removal`, `verified_minimal`,
`fixed_entities`; per-cluster rank, conditioning and a `near_degenerate` flag; and an
`explanation` paragraph.

**Corpus (generated, no external data).** `generate::corpus(2026, 1000)`: rectangles 250
(4 shared corners or 8 endpoints + coincident; bare, H/V, dimensioned, fixed, rotated
with parallel/perpendicular + angle to a fixed line, square, plus one extra redundant or
conflicting constraint), slots 125 (joint tangencies, equal radii, separate/shared
endpoints), bolt circles 125 (3–8 holes, point-on-circle, equal, angles, closing angle
redundant or conflicting), rounded rectangles 125 (8 line–arc joint tangencies), arc
chains 125 (arc–arc joint tangency), random polygons 250 (random measured distances,
point–line distances, angles, fixes; half with one value perturbed). Input coordinates
are ground truth plus noise. Intents: 402 under, 255 fully, 126 redundant, 217 conflict.

**Oracles (CI/dev tooling only, in `forge/crates/forge-solve/oracle/`).**
- PlaneGCS: FreeCAD's solver compiled to wasm, `@salusoft89/planegcs` 1.2.0
  (LGPL-2.0-or-later), pinned by `package.json` + lockfile; `planegcs_oracle.mjs`.
- SolveSpace: `python-solvespace` 3.0.8 (GPL-3.0), CPython 3.11 wheel (source builds
  fail on 3.10/3.12/3.13), inline `uv` script `solvespace_oracle.py`. Joint tangencies map
  to `ARC_LINE_TANGENT` / `CURVE_CURVE_TANGENT` with the correct start/end flags.
- Both harnesses also **verify** Forge's claims with the oracle itself: each Forge MCS must
  fail to solve in PlaneGCS, and dropping any single member must make it solve; each
  Forge-redundant constraint must leave PlaneGCS's DOF unchanged when dropped.

**Hardware / targets.** Apple M4 Pro, macOS (Darwin 27.0), Rust 1.92.0, Node v22.16.0 (V8).
The library builds for `wasm32-unknown-unknown`; timings in WASM use the same benchmark
built for `wasm32-wasip1` and run under Node's built-in WASI (no wasm-bindgen, no
`unsafe` exports; the `wasm32-wasip1` std was added to the local 1.92 toolchain with
`rustup target add`).

**Commands** (from `forge/`):

```bash
cargo test -p forge-solve                                   # 38 tests (+ proptest cases)
cargo clippy -p forge-solve --all-targets -- -D warnings
cargo build -p forge-solve --target wasm32-unknown-unknown --release

# oracle corpus + comparisons
cargo run -p forge-solve --release --example oracle_corpus -- <dir> 1000 2026
(cd crates/forge-solve/oracle && npm ci && node planegcs_oracle.mjs <dir>)
uv run crates/forge-solve/oracle/solvespace_oracle.py <dir>

# performance: native, then WASM in Node
cargo run -p forge-solve --release --example bench
cargo build -p forge-solve --release --example bench --target wasm32-wasip1
node crates/forge-solve/oracle/wasm_bench.mjs target/wasm32-wasip1/release/examples/bench.wasm
```

## Results

| Criterion | Target | Measured | Pass? |
|---|---|---|---|
| Drag frame, 200 entities (234 unknowns, one cluster), WASM | ≤ 4 ms | p50 0.13 ms, p95 0.41 ms, **max 1.75 ms** over 600 frames (fully constrained); p50 0.05 ms, max 0.24 ms (under-constrained, the geometry moves) | ✅ |
| Drag frame, 60 entities, WASM | ≤ 4 ms | p50 0.03 ms, max 0.23 ms | ✅ |
| DOF counts vs PlaneGCS | match on 1k | **799/800 (99.9 %)** of the sketches PlaneGCS diagnoses without a conflict (PlaneGCS's DOF is not rank-based once it reports a conflict: it returns −1…−6 there) | ✅ |
| DOF counts vs SolveSpace | match on 1k | **748/748 (100 %)** of the sketches both solve | ✅ |
| DOF counts vs analytic design values | — | 598/598 | ✅ |
| Redundancy vs PlaneGCS | match on 1k | detection **259/259 (100 %)**; every Forge-redundant constraint confirmed by PlaneGCS (drop it: still solves, same DOF) **459/459** | ✅ |
| Redundancy vs SolveSpace | match on 1k | redundant-or-conflict vs clean **994/1000 (99.4 %)** | ✅ |
| Minimal conflict sets vs PlaneGCS | match on 1k | conflict detected by both **184/185**; every Forge MCS confirmed contradictory by PlaneGCS **212/212**; every MCS Forge marks `verified_minimal` confirmed minimal by PlaneGCS **202/202** (the other 10 are flagged `verified_minimal: false`; PlaneGCS cannot solve a
one-smaller subset of them from the drawn geometry either); design-intended MCS reproduced **95/95**; Forge's set ⊆ PlaneGCS's conflicting list 180/184, equal 147/184 | ✅ |
| Status class (clean / redundant / conflict) | — | PlaneGCS 983/1000 raw, 999/1000 adjudicated; SolveSpace 933/1000 raw, 994/1000 adjudicated (see below) | ✅ |
| Determinism | bit-identical on every target | FNV hash of every output bit identical native aarch64 vs wasm32 (`39ec20a99e9b8750`); same input ⇒ same JSON (proptest); QRCP vs Jacobi-SVD status + DOF 1000/1000 | ✅ |

**Performance** (600 drag frames on a 1.5 mm circle; median of 7 full solves):

| Target | Sketch | Unknowns | Solve + diagnostics | Drag p50 | Drag p95 | Drag max | LM it./frame |
|---|---|---|---|---|---|---|---|
| native | 60, fully | 68 | 0.21 ms | 0.021 ms | 0.022 ms | 0.048 ms | 4.7 |
| native | 200, fully | 234 | 3.6 ms | 0.10 ms | 0.11 ms | 0.21 ms | 4.6 |
| native | 200, under (11 DOF) | 234 | 3.8 ms | 0.04 ms | 0.04 ms | 0.56 ms | 2.0 |
| WASM (Node 22) | 60, fully | 68 | 0.62 ms | 0.027 ms | 0.060 ms | 0.23 ms | 4.7 |
| WASM (Node 22) | 200, fully | 234 | 5.4 ms | 0.13 ms | 0.41 ms | 1.75 ms | 4.6 |
| WASM (Node 22) | 200, under (11 DOF) | 234 | 5.5 ms | 0.05 ms | 0.11 ms | 0.24 ms | 2.0 |

Coarser drags (30 frames per circle) take about 3 iterations and ≤ 0.13 ms per frame in
WASM. The whole 1k corpus solves with full diagnostics in 93 ms natively (p50 58 µs,
p99 0.54 ms per sketch). WASM worst frames vary between runs (JIT/GC); none exceeded
1.8 ms.

**Disagreements, explained** (all per-sketch records are in `planegcs.jsonl`,
`solvespace.jsonl`, `summary*.json` of the run directory):
- *PlaneGCS labels a redundancy "conflicting" although its own solve succeeds* (16 slots
  with a redundant `parallel`/`equal`/`distance` on the tangent lines): a consistent
  system cannot conflict; Forge says redundant. Counted as agreement in "adjudicated".
  PlaneGCS reports DOF −1 for them, so they fall outside the DOF rate (which counts only
  sketches PlaneGCS reports conflict-free); the single DOF difference inside that rate is
  the polygon described below.
- *Forge's MCS is smaller than PlaneGCS's conflicting list* (33 sketches): PlaneGCS
  reports whole linear-dependency groups; Forge reports the true minimal set, which
  PlaneGCS itself confirms. Example: `angle(L0, L1) = 80°` with `horizontal(L0)`,
  `vertical(L1)` → Forge `{h, v, angle}`; PlaneGCS adds the two unrelated side lengths.
  For slots with an over-long tangent line, Forge shows the equal-radius and radius
  constraints are not needed. In 4 multi-conflict polygons the union of Forge's sets and
  PlaneGCS's list differ (MCSs are not unique).
- *Redundancy attribution* (85 sketches): which member of a dependency is "the redundant
  one" is a choice. Forge names the most recent; PlaneGCS uses a greedy pick and
  sometimes under-reports (four copies of one distance: Forge 3 redundant, PlaneGCS 1).
  Every Forge claim is independently confirmed (459/459).
- *PlaneGCS "failed" without diagnosing* (1 polygon, triangle-inequality-type conflict):
  PlaneGCS confirms Forge's MCS is contradictory and minimal; DOF differs because
  PlaneGCS ranks the Jacobian at the (infeasible) input, Forge after removing the
  suggested constraint.
- *SolveSpace*: its library returns `INCONSISTENT` for both redundant and conflicting
  systems and does not converge on 61 consistent-but-redundant polygons whose Forge
  solutions pass the independent checker (adjudicated); 6 consistent sketches end in
  `DIDNT_CONVERGE`. Its `failed` list means "equations left unsatisfied", so MCS
  containment (123/212) and redundancy containment (21/282) are informative only.
- *Backends*: QRCP and Jacobi SVD differ in one sketch with three independent conflicts:
  the second MCS differs (both valid; MCSs are not unique).

**Failure zoo (found by the oracles/tests during the spike, all fixed):**
1. Distance-form tangency at shared endpoints is a double root → conditioning 1e-6, LM
   stalls, false conflicts. Joint tangency formulation: conditioning 0.14–0.3, 19 → 3
   iterations.
2. Angular residuals scaled by current lengths are satisfied by collapsing lines → a
   bolt-circle MCS wrongly included the circle radius. Constant scale from the input.
3. Equation-space Marquardt damping gave negative predicted reductions → LM stalled on a
   consistent subsystem → an MCS PlaneGCS could solve. Isotropic damping.
4. A starved LM (`max_iterations = 1`) produced invented single-constraint conflicts on a
   consistent triangle. Three-valued verdicts: now `failed_to_converge`.
5. The generator pinned `fix` constraints at noisy positions and mis-ordered rounded
   rectangle corners: generator bugs, fixed.
6. Reverse-Cuthill–McKee envelope Cholesky smeared hub equations: 590 k multiply-adds per
   factorization at 200 entities; minimum-degree sparse Cholesky: 28 k (21×), drag p50
   0.68 → 0.10 ms natively.

**Tests.** 38 tests: 7 unit (dense QRCP/SVD rank and null spaces, sparse Cholesky vs
dense, minimum degree, AD vs central finite differences for all 21 equation variants
(proptest, 64 cases), AD vs hand-derived gradients for 7 kinds), 16 canonical (e.g. the
unconstrained 4-line rectangle with coincident corners has 8 DOF, H/V → 4, + 2 dims → 2,
+ fix → 0; a redundant parallel is flagged with what implies it; contradicting dimensions
→ exactly `{d10, d12}`; triangle inequality → `{d1, d2, d3}` without the fix; partial
redundancy; constraints on fixed geometry; two independent conflicts; free directions),
7 API/JSON (error codes, round trips, drag behavior), 6 property tests (5 proptests over
160 generated sketches each — solutions satisfy every constraint to 1e-10 and, via an
independent checker written without the solver's residual code, to 1e-9; drags keep
constraints satisfied or reject the frame without moving anything; status/DOF/MCS match
design intent; determinism and backend agreement; solved geometry is a fixed point — plus
a corpus-coverage test), 2 doctests.

## Verdict: GO

Both criteria are met with margin: the worst WASM drag frame on a 200-entity single
cluster is 1.75 ms against a 4 ms budget (p50 0.13 ms), and the diagnostics agree with
two independent solvers wherever those solvers are themselves decisive — DOF 99.9 % /
100 %, redundancy detection 100 %, conflict detection 99.5 %. More importantly, each
Forge answer that differs from PlaneGCS was checked with PlaneGCS itself, and every
claim held: 212/212 conflicts are contradictory, 202/202 sets marked minimal are
minimal, 459/459 redundancies drop without changing the DOF. Confidence is high for the
constraint set exercised here (lines, circles, arcs, joint tangency, dimensions);
medium for very large single clusters, where the dense rank analysis (O(n³), 3.6 ms at
234 unknowns) will need a sparse or DR-planning approach before ~1,000 unknowns.

## Follow-ups

- [ ] DR-planning / rigid-cluster decomposition; sparse rank-revealing QR for the
      diagnostics of very large clusters (only connected components today).
- [ ] Enable `serde_json`'s `float_roundtrip` feature workspace-wide: without it a
      decimal can parse 1 ULP away from the `f64` that printed it (deterministically on
      every target), so JSON print → parse is not bit-exact. Not changed here because it
      would alter float parsing in every other crate.
- [ ] Constraint section of the IR (`forge-ir` schema + zod) from these types; ids are
      already the IR ids.
- [ ] Expose the stateful `Solver` to TypeScript through the WASM crate (drag loop next to
      the UI), with a JSON or typed-array boundary.
- [ ] Wire both oracle harnesses into CI (pinned Node and CPython 3.11; mark
      `forge-solve/oracle/` as test tooling for the JS licence check); add
      `wasm32-wasip1` to CI for the WASM timing harness.
- [ ] More geometry and constraints: ellipses, splines, arc length, horizontal/vertical
      distance, symmetric about a point, equal line–arc length, bounded point-on-arc.
- [ ] Drag: optional true weighted projection (pull toward the pre-drag state each
      iteration) and a per-frame time budget.
- [ ] Add `forge-solve` to the repo map in `CLAUDE.md` (left to maintainers; several
      crates are being added concurrently).

# Spike 03: SSI + boolean feasibility — the SSI half (`forge-ssi`)

- **Owner / workstream:** SSI agent (Claude Code), main working tree (no git in this workstream)
- **Dates:** 2026-09-23 → 2026-09-23
- **Commit(s):** uncommitted; `forge/crates/forge-ssi/` (new, MPL-2.0) and an additive
  `forge-core` module `geom/surface/implicit.rs` (+1 line in `geom/surface/mod.rs`)
- **Verdict:** **GO** for the SSI half (booleans are the second half of spike 3)

## Goal

Can we own certified surface–surface (SSI) and curve–surface intersection for the analytic
surfaces (plane, cylinder, cone, sphere, torus)? It must be correct in the hard cases
(tangency, coincidence, singular points, closed loops), explain its failures, give
bit-identical results on every target, and be good enough to build F1 booleans on
([ADR 0000](../adr/0000-own-the-core.md), [ADR 0003](../adr/0003-forge-kernel-with-occt-oracle.md)).

Criteria, verbatim from [README.md](README.md):

| # | Setup | GO when |
|---|---|---|
| 3 | Certified intersection for plane/cylinder/cone/sphere/torus pairs; booleans on 500 DeepCAD replays | <ul><li>≥99% agreement with the oracle.</li><li>0 silent-wrong results.</li></ul> The result sets the pace for F1. |

This report covers the SSI part. The DeepCAD boolean replays need the boolean
implementation (see [What the booleans need next](#what-the-boolean-implementation-needs-next)).

**Change to the criterion, recorded as the rules require.** "Agreement with the oracle"
cannot be measured as raw agreement with OCCT. OCCT's own SSI is wrong on 3.6% of the
analytic pairs in this corpus: it misses tangent contacts, drops branches, leaves gaps in
closed loops and returns curves up to 109 mm off the surfaces. So every disagreement was
**adjudicated by independent evidence**: a dense brute-force truth sampler plus closed
forms and constructed tangencies. The criterion is read as: correct in ≥99% of pairs,
meaning agreement, or a disagreement decided in Forge's favour; 0 silent-wrong. Raw
agreement is reported too.

## Setup

**Code.** `forge/crates/forge-ssi` has about 8.7k lines of Rust, 1.6k lines of tests and
1.2k lines of tooling (examples, wasm runners, the Python oracle).
- Runtime dependencies: `forge-core` and `thiserror` only.
- Dev-dependencies: `serde_json`, plus `proptest` on native targets only.
- No new workspace dependency and no `unsafe`.
- Everything that is certified is written once over `forge_core::Scalar` and run with
  `f64`, `Interval` and `Dual` (nested for second derivatives).

| Module | What |
|---|---|
| `forge-core::geom::surface::implicit` (new, additive) | Per surface: a **distance form** `d(p)` with `\|d\| ≥ dist(p, S)` (equal near S), its gradient, and the **algebraic form** `q(p)` (degree 1/2/4). Generic over `Scalar`; 5 tests. |
| `roots1d`, `poly` | Certified 1D root isolation: interval exclusion, monotonicity + interval-Newton certificates, clusters → tangent roots and flat ranges. Stable quadratic, quartic via recursive derivative isolation, trig polynomials via half-angle on two charts. |
| `curve_surface` | `intersect_curve_surface`. |
| `ssi::exact`, `ssi::carrier` | Closed forms and exact carriers (lines, circles, ellipses, exact rational parabola/hyperbola arcs) with exact or fitted pcurves. |
| `ssi::march` | Certified subdivision, tracing, cluster resolution (tangent points, singular vertices, pass-throughs). |
| `ssi::fit`, `ssi::bound` | Quintic Hermite B-spline fitting of the 3D curve and both pcurves; Bernstein-form certified error bound. |
| `clip` | Certified clipping of curves to parameter boxes. |
| `corpus` | Deterministic pair corpus (SplitMix64), determinism fingerprint. |
| `oracle/occt_ssi_diff.py` | OCCT differential oracle + truth sampler (dev tooling only; OCCT is LGPL). |
| `examples/` | `ssi_oracle_batch` (corpus → JSONL), `ssi_bench`, `ssi_fingerprint[_check]`, `ssi_case`. |
| `wasm/` | Node runners for wasm32-wasip1 and wasm32-unknown-unknown. |

**Corpus.** `corpus::random_pairs(seed, n)` produces the 15 unordered pairs of the 5
surface kinds round-robin, with random frames, radii and parameter boxes (extent 8 mm).
28% of pairs are structured special configurations:
- plane–plane: coincident, parallel;
- plane–cylinder: parallel, tangent line, perpendicular;
- plane–cone: perpendicular, through the apex, parabola;
- plane–sphere: tangent, offset;
- plane–torus: perpendicular, meridian, Villarceau;
- cylinder–cylinder: coaxial, parallel, equal radius with crossing axes;
- sphere–sphere: tangent (external/internal), concentric;
- coaxial pairs of every kind;
- a sphere tangent at a point to a curved surface.

Two independent seeds (17 and 5) × 2,400 pairs are used for the OCCT comparison.

**Oracle.** OCCT 7.9.3 (`cadquery-ocp-novtk 7.9.3.1.1`, Python 3.13.7, repo `oracle/`
uv env). It runs `GeomInt_IntSS` at tolerance 1e-7 with approximation on, and clips the
results to Forge's parameter boxes (Forge's parametrization conventions, boundary points
refined by bisection).

**Hardware / toolchain.** Apple M4 Pro (14 cores), 48 GB, macOS 27.0, Rust 1.92.0,
Node 22.16.0. Other agents were building in the same workspace, so the load average
during timing runs was 5–8.

**Reproduce** (from `forge/`):

```text
cargo test -p forge-ssi                                   # 63 tests (debug ≈ 25 s)
cargo clippy -p forge-ssi --all-targets --no-deps -- -D warnings   # see open issue 8
cargo fmt -p forge-ssi --check
PROPTEST_CASES=3000 cargo test -p forge-ssi --release --test ssi_properties --test curve_surface
cargo build -p forge-ssi --target wasm32-unknown-unknown
# determinism
cargo run --release -p forge-ssi --example ssi_fingerprint
cargo build --release -p forge-ssi --example ssi_fingerprint --target wasm32-wasip1
node crates/forge-ssi/wasm/run_fingerprint.mjs target/wasm32-wasip1/release/examples/ssi_fingerprint.wasm
cargo build --release -p forge-ssi --example ssi_fingerprint_check --target wasm32-unknown-unknown
node crates/forge-ssi/wasm/run_unknown.mjs target/wasm32-unknown-unknown/release/examples/ssi_fingerprint_check.wasm
# OCCT differential (≈ 3 min per 2,400 pairs) and timings
cargo run --release -p forge-ssi --example ssi_oracle_batch -- --seed 17 --count 2400 --out /tmp/b17.jsonl
(cd ../oracle && uv run python ../forge/crates/forge-ssi/oracle/occt_ssi_diff.py /tmp/b17.jsonl --out /tmp/r17.json)
(cd ../oracle && uv run python ../forge/crates/forge-ssi/oracle/occt_ssi_diff.py /tmp/b17.jsonl --bench)
cargo run --release -p forge-ssi --example ssi_bench -- --seed 17 --count 2400 --repeat 7
```

## Results

| Criterion | Target | Measured | Pass? |
|---|---|---|---|
| Correct vs oracle (agree, or disagreement adjudicated for Forge) | ≥99% | **100%** of 4,800 pairs: 4,585 agree, 41 coincidences flagged (OCCT returns nothing), 174 OCCT-wrong. 0 Forge-wrong, 0 both-wrong, 0 errors. | ✅ |
| Raw agreement with OCCT (for reference) | — | 95.5% (seed 17: 95.33%, seed 5: 95.71%) | — |
| Silent-wrong results | 0 | **0**: 4,800 corpus pairs; 21,000 property cases (3,000 × 7 families) + 3,000 curve–surface cases, all with a dense missed-branch detector; a near-degenerate sweep where every failure is a structured error | ✅ |
| Output tolerance `fit` = 1e-7 mm | every point on both surfaces | certified bound ≤ 3.9e-8 on every branch; sampled max 2.5e-8 | ✅ |
| Bit-identical results | native = wasm32 | `0x25d31489fbd5d1e6`: native release, native debug, wasm32-wasip1, wasm32-unknown-unknown | ✅ |

### API

```rust
pub fn intersect_curve_surface(curve: &Curve3, t_range: (f64, f64), surface: &Surface,
    domain: UvBox, tol: &SsiTolerance) -> Result<CurveSurfaceHits, SsiError>;
pub fn intersect_surfaces(a: &Surface, domain_a: UvBox, b: &Surface, domain_b: UvBox,
    tol: &SsiTolerance) -> Result<IntersectionGraph, SsiError>;
```

- `SsiTolerance { fit: 1e-7, linear: 1e-6 (IR), resolution: 1e-5, max_cells: 400_000 }`.
  `fit` is the output contract and the tangency snap distance.
- `CurveSurfaceHits { points, overlaps, certified_complete }`. Each hit carries `t`,
  `(u, v)`, the point, `Contact` (transversal / tangent with gap), multiplicity 1–3 and
  a `RootCertificate` (t enclosure, residual enclosure containing 0, uniqueness,
  distance bound). Overlaps are parameter ranges where the curve lies in the surface.
- `IntersectionGraph { branches, vertices, coincidence, method, certified_complete, stats }`.
  - Each `Branch` has a `Curve3`, a `range`, `pcurve_a`/`pcurve_b` (`Curve2`, same `t`),
    `closed`, `contact` (tangent branches flagged), `sense` (orientation relative to
    `n_a × n_b`), `Exact | Fitted`, start/end vertex indices, a certified `error_bound`
    and `min_angle` (near-tangency warning).
  - Vertex kinds: `DomainBoundary`, `TangentPoint`, `Singular` (branch crossing),
    `SurfaceSingularity` (apex, pole).
  - `Coincidence { same_orientation, uv_map: Option<UvAffine> }`.
  - Ordering is deterministic: branches by start point, marched branches along
    `n_a × n_b`.
- Errors are `SsiError` with stable codes and diagnostics (3D point, parameters on both
  operands, measured value vs limit):
  - `SSI_INVALID_DOMAIN`, `SSI_INVALID_TOLERANCE`, `SSI_UNSUPPORTED` (B-spline surfaces);
  - `SSI_TANGENT_UNRESOLVED`, `SSI_NOT_CONVERGED`, `SSI_FIT_FAILED`;
  - `SSI_BUDGET_EXCEEDED`, `SSI_INCONSISTENT`.

### Algorithms, completeness and tangency

Full descriptions are in the crate docs and module docs; this is the summary.

- **Curve–surface.**
  - Take `g(t) = d_S(C(t))`. Lines, circles and ellipses get closed-form candidates; each
    candidate is certified by interval Newton (unique root, residual ∋ 0).
  - Everything outside the candidates' enclosures is proven root-free by the certified
    root finder. That makes the hit list **complete**.
  - Roots that cannot be isolated are tangent (multiplicity 2/3, odd if `g` changes sign).
  - Two roots joined by an arc within `fit` of the surface merge into one tangential
    contact.
  - Flat `|g| ≤ fit` ranges are overlaps.
  - B-spline curves are searched knot span by knot span, because interval evaluation is
    only valid inside one span.
- **Closed forms** (every exact branch is re-certified; a failed certificate falls back
  to marching):
  - plane–plane;
  - common extrusion direction: a 2D line/circle arrangement gives lines;
  - common axis of revolution: a meridian arrangement in the full `(ρ, h)` plane gives
    circles. This covers every plane–sphere and sphere–sphere pair and all coaxial pairs;
  - oblique plane–cylinder (ellipse);
  - plane–cone: ellipse, **exact rational** parabola/hyperbola arcs, line pairs through
    the apex, or the apex alone;
  - plane through a torus axis (meridian circles);
  - **bitangent plane of a ring torus: the two Villarceau circles**, split at their two
    tangential crossings (new in this spike);
  - equal cylinders with crossing axes: two ellipses, split at the tangency points;
  - coincidence, with an affine uv map where one exists.

  Decisions snap at `0.1·fit` over the problem size.
- **Marching** (everything else) solves `G(u,v) = d_Q(S_P(u,v)) = 0` in the box of the
  better-parametrized surface `P`.
  - **Completeness certificate.** A quadtree (non-dyadic split ratios) classifies every
    cell with interval arithmetic:
    - *excluded*: `0 ∉ G(cell)`;
    - *regular*: `G_u` or `G_v` certainly ≠ 0. Then the curve is a graph over the cell,
      no closed loop fits inside, and every piece reaches the cell boundary, where the
      certified 1D root finder finds all crossings;
    - *irregular* at the resolution limit.

    The tracer consumes crossings until none is unvisited, so every piece of curve that
    meets a regular cell, closed loops included, is traced.
  - **Tangency and singular points.** Irregular cells form clusters, and each is resolved
    explicitly:
    - no branch ends and a gap ≤ `fit` → `TangentPoint` vertex (with the gap);
    - no branch ends otherwise → certified empty on a finer grid;
    - branch ends → a singular vertex (Newton on `∇G = 0`; branch crossings, apex/pole),
      or a pass-through;
    - anything else → `SSI_TANGENT_UNRESOLVED`.

    Tangential contact is always reported explicitly, never silently dropped.
    `certified_complete` is false when a pass-through or a safety net was used.
  - **Fitting.** Nodes are exact curve points with exact `C'`, `C''` and parameter
    derivatives on both surfaces. Spans are quintic Hermite (C²), with the 3D curve and
    both pcurves sharing `t`. Refinement runs until the error estimate is < `fit/4`, then
    the result is stored as a degree-5 B-spline.
  - **Certification.** For each Bézier segment, a Bernstein bound of the homogenized
    algebraic residual is converted to a distance through the exact factorization of the
    surface form. That gives a proven `error_bound ≤ fit`. Pcurve consistency is verified
    on 16 samples per span.

### Coverage (seed 17, 2,400 pairs; every pair `certified_complete`)

| Pair | Configurations | Method | Output |
|---|---|---|---|
| plane–plane | general / parallel / coincident | PlanePlane | exact line / none / coincidence + uv map |
| plane–cylinder | oblique / ∥ axis / tangent / ⟂ axis | PlaneCylinder, CommonExtrusion, CommonAxis | exact ellipse / lines / **tangent line** / circle |
| plane–cone | general / parabola / through apex / ⟂ axis | PlaneCone, CommonAxis | exact ellipse, rational parabola & hyperbola arcs, line pairs, apex point / circle |
| plane–sphere | general / offset / tangent | CommonAxis | exact circle / **tangent point** (radius √(R²−d²) checked) |
| plane–torus | general / meridian / ⟂ axis / Villarceau | Marching, PlaneTorusMeridian, CommonAxis, PlaneTorusVillarceau | fitted loops / 2 circles / circles incl. **tangent circles** / 2 circles crossing at 2 singular vertices |
| cylinder–cylinder | general / parallel / coaxial / equal radius crossing | Marching, CommonExtrusion, EqualCylinders | fitted loops or arcs / lines incl. **tangent lines** / coincidence / 2 ellipses split at 2 singular vertices |
| cylinder–cone, cylinder–sphere, cylinder–torus, cone–cone, cone–sphere, cone–torus, sphere–torus, torus–torus | general | Marching | fitted loops / arcs, domain-boundary vertices |
| same pairs | coaxial | CommonAxis | exact circles (tangent circles flagged) |
| cylinder/cone–sphere | sphere tangent at a point | Marching | **TangentPoint** vertex |
| sphere–sphere | general / tangent ext. & int. / concentric | CommonAxis | exact circle / **tangent point** / none or coincidence |

Branches: 1,029 exact and 1,680 fitted. Tangent entities: 22 tangent lines and 4 tangent
circles; 75 isolated tangent points; 50 singular vertices.

### Accuracy

- **Certified** `error_bound` (max over branches), which bounds both the distance to
  either surface and pcurve consistency:
  - exact curves with exact (affine) pcurves (lines, coaxial circles): ≤ 3.2e-12;
  - exact curves whose pcurves are fitted (circles on spheres and tori, ellipses,
    conic NURBS): ≤ 2.7e-8, dominated by the pcurve fit;
  - fitted branches: ≤ 3.9e-8.
- Sampled on the exported polylines (sagitta ≤ 1e-5 mm), the max distance to both
  surfaces is **2.49e-8 mm** on both seeds. OCCT's is 109 mm (seed 17) and 86 mm
  (seed 5); its median is 4.5e-8.
- The closed-form property tests match exactly:
  - plane–sphere radius `√(R²−d²)`;
  - sphere–sphere radical-plane circle;
  - coaxial circles;
  - Villarceau: 4 exact arcs of radius R, total length 2·2πR to 1e-9;
  - the near-Villarceau section length against an independent quadrature, to 1e-4.

### Completeness

- The missed-branch detector (tests) samples each surface on a 160–240² grid, finds
  sign changes of the other surface's distance form, **bisects them to the exact
  crossing** and requires each to lie within 0.05 mm of the output. It runs in every
  marching/property test, both ways.
- Soak: 3,000 random cases in each of 7 families (general quadric/torus pairs with
  random frames and radii, plane–sphere, tangent planes, sphere–sphere, coaxial pairs,
  tangent spheres on curved surfaces, coincidence) + 3,000 curve–surface cases. All
  pass.
- OCCT truth sampler: over 4,800 pairs, Forge missed 0 truth points and 0 tangential
  contacts, and has 0 dangling curve ends.

### OCCT differential (2 × 2,400 pairs)

*Agree* means: Hausdorff distance ≤ 1e-4 mm (both sides sampled with sagitta ≤ 1e-5
mm), the same number of connected components and closed loops after end-gluing, and
isolated points matched within 1e-3 mm. Every other case is adjudicated by the truth
sampler:
- a 360² grid on each surface;
- sign changes of the other distance form, bisected, give points certainly on both
  surfaces;
- plus a local 121² re-sampling around the worst discrepancy;
- plus curve ends that are neither on a box boundary nor at a contact ("dangling").

| | seed 17 | seed 5 |
|---|---|---|
| agree | 2,288 (95.33%) | 2,297 (95.71%) |
| coincident (Forge coincidence + uv map; OCCT returns nothing) | 20 | 21 |
| **OCCT wrong** | **92 (3.83%)** | **82 (3.42%)** |
| Forge wrong / both wrong / errors | 0 / 0 / 0 | 0 / 0 / 0 |
| Hausdorff of agreeing cases: median / p99 / max (mm) | 9.3e-6 / 1.1e-5 / 9.8e-5 | 8.4e-6 / 1.1e-5 / 8.6e-5 |

OCCT failure modes (primary reason; seed 17 + seed 5):

| Failure | Count | Where | Example |
|---|---|---|---|
| Missed tangent contact (returns nothing) | 49 + 43 | plane–sphere, sphere–sphere, cylinder/cone–sphere tangent configurations | #33: plane at distance R from a sphere centre. Forge returns one `TangentPoint`, exact by construction. |
| Points off the surfaces | 27 + 21 | mostly cone–cone, cylinder–cone | #24: part of an OCCT curve lies 28.8 mm off the surfaces (a garbage component). Forge's closed loop is within 2e-8 of both. |
| Missed branch | 12 + 11 | cone–cone | #9: OCCT returns nothing; the truth sampler finds 1,511 intersection points, all covered by Forge. |
| Gap in a closed loop | 4 + 7 | torus–torus, sphere–torus | #28: OCCT's loop has a hole about 1e-2 mm wide. The true curve there is within 1e-5 of Forge's (the sampling sagitta). |

OCCT also returned duplicate curves in 12 + 8 cases (deduplicated before comparison).
The Hausdorff tail of agreeing cases (max ~1e-4) is OCCT's approximation error; Forge's
point error is ≤ 2.5e-8.

**Investigated and fixed on the tooling side.** Two false "Forge wrong" verdicts came
from the tooling, not the kernel:
- The exporter checked chord sagitta only at the parameter midpoint, which an arc with
  an inflection passes. It now checks the quarter points.
- The missed-branch detector interpolated linearly, which misplaces crossings where the
  distance form is far from linear (near-tangential cases). It now bisects.

**The harness catches regressions.** A node-placement bug introduced while hardening the
fitter (clip-point nodes moved to the span midpoint) showed up at once as 14 + 7
"Forge wrong" cases, and as a property-test failure. It was fixed; the final runs above
have 0.

### Tangency, coincidence and near-degenerate robustness

- **Exact tangencies** come from closed forms or constructed configurations: tangent
  lines, tangent circles, tangent points and Villarceau crossings. They are reported
  with `Contact::Tangent`, and property-tested with 3,000 random frames per family.
- **Coincidence** (same surface in another frame: shifted, rotated, axis flipped) is
  flagged with the orientation of the actual normals. The affine uv map is verified
  point-wise to 1e-9.
- **Near-degenerate sweep** (offset δ just outside the `0.1·fit` snap):

  | Configuration | δ = 1e-9 | 1e-7 | 1e-6 | 1e-5 | 1e-3 |
  |---|---|---|---|---|---|
  | sphere pushed into a torus | ✅ | ✅ | ✅ | ✅ | ✅ |
  | sphere of the cylinder's radius, centre δ off the axis (thin lens, tips of radius ≈ δ) | ✅ snapped (CommonAxis), 1 circle | ✅ (uncertified flag, 3.4 s) | ❌ `SSI_NOT_CONVERGED` | ✅ (uncertified flag) | ✅ |
  | equal cylinders, axes missing by δ (near-crossing) | ✅ snapped, 2 ellipses | ❌ `SSI_NOT_CONVERGED` | ❌ | ❌ | ✅ |

  ✅ means the contract and the missed-branch detector hold both ways; ❌ is an explicit
  error, never a wrong answer. These are the main open issues (below).

### Determinism

- The fingerprint is FNV-1a over the bit patterns of every returned sample, parameter,
  bound, vertex and error code for 150 SSI pairs + 120 curve–surface queries.
- `0x25d31489fbd5d1e6` is identical on native release, native debug, wasm32-wasip1
  (Node WASI, 0.34 s) and wasm32-unknown-unknown (no imports; exit code compared,
  0.34 s). Two native runs match.
- A deliberate perturbation changes it (negative control).
- `tests/determinism_golden.rs` pins the value.
- The value also did not change when another workstream rewrote `forge-core`'s
  `Interval`/`math` during this spike.

### Performance

`ssi_bench`, best of 7 runs per pair, seed 17 (medians in µs). The OCCT columns are
`GeomInt_IntSS` best of 3 through Python; OCCT intersects the untrimmed surfaces.

| Family | Forge median | Forge p90 | OCCT (no pcurves) | OCCT (with pcurves) |
|---|---|---|---|---|
| plane–plane general | 19 | 20 | 1 | 1 |
| plane–cylinder general | 52 | 144 | 4 | 59 |
| plane–cone general / parabola | 316 / 325 | 597 / 459 | 5 / 4 | 4 / 4 |
| plane–sphere general | 66 | 102 | 5 | 211 |
| sphere–sphere general | 104 | 154 | 14 | 429 |
| coaxial pairs (all kinds) | 15–60 | 16–65 | 1–58 | 1–57 |
| plane–torus Villarceau | 117 | 128 | 5,241 | 4,184 |
| equal cylinders crossing | 117 | 188 | 15 | 265 |
| cylinder–sphere general | 1,220 | 2,050 | 2,409 | 3,899 |
| cone–sphere general | 1,315 | 2,073 | 4,124 | 6,754 |
| plane–torus general | 1,658 | 2,570 | 2,813 | 3,250 |
| cylinder–cylinder general | 1,834 | 2,484 | 1,960 | 3,349 |
| sphere–torus general | 2,285 | 4,092 | 1,845 | 2,409 |
| cylinder–cone general | 2,352 | 3,334 | 6,395 | 9,938 |
| cylinder–torus general | 3,962 | 5,866 | 4,603 | 5,878 |
| cone–cone general | 4,196 | 7,870 | 14,786 | 21,820 |
| cone–torus general | 4,858 | 7,568 | 7,285 | 8,801 |
| torus–torus general | 6,538 | 9,801 | 44,598 | 49,776 |
| **mean over all 2,400 pairs** | **1,705** | | **4,717** | **6,070** |

- Worst pair: 12.5 ms (torus–torus).
- Curve–surface medians:
  - line × plane 1.8 µs, line × cylinder/sphere 7 µs, line × cone/torus 13 µs;
  - circle × plane 14 µs, circle × other surfaces 21–30 µs.
- On closed forms OCCT without pcurves is 10–60× faster. Forge also clips to the boxes,
  builds pcurves and certifies. With pcurves OCCT is slower on plane–sphere and
  sphere–sphere, whose pcurves are non-affine: fitting them dominates Forge's time too.
- On marching families Forge is 1.1–7× faster than OCCT. The exceptions are
  sphere–torus (OCCT 1.2× faster) and the tangent-point families, where OCCT is fast
  because it returns nothing (wrongly).
- **Slowdowns caused and fixed during the spike:**
  - Certification split a segment up to 2¹⁴ times when its true error sat just under
    the target, or was genuinely over it (71 ms). It now splits to the preferred target
    but accepts the contractual limit below depth 4, and exits early on a witnessed
    violation.
  - A duplicated traced end point flipped a node tangent (2,068 spans → 223).
  - Clip points were not refined.
  - Villarceau went through marching (19–60 ms → 0.12 ms, now exact).
- **External regression.** A concurrent `forge-core` change to `Interval` (empty checks,
  the `0·∞` convention, ±0-deterministic min/max folding on every operation) made SSI
  ~40% slower. A/B with identical SSI code: line × sphere 5.4 → 7.7 µs, torus–torus
  4.8 → 6.6 ms. Results are unchanged. The numbers above are after that change.

## Verdict: GO (SSI half)

- On 4,800 random and structured analytic pairs, `forge-ssi` is right every time the
  truth sampler can judge. OCCT is wrong 3.6% of the time: missed tangencies, missed
  branches, gaps, curves far off the surfaces.
- Every branch carries a proven error bound ≤ `fit`, and every result a completeness
  certificate: 2,400/2,400 certified.
- Output is bit-identical on native and wasm32.
- It is usually faster than OCCT on the hard (marching) pairs.
- In the near-degenerate regime (surfaces within ~1e-7…1e-4 of tangency along a curve,
  or near-crossings) some configurations still end in a structured `SSI_NOT_CONVERGED`
  instead of a result. Never a wrong answer, but booleans on real models will meet that
  regime, so it is the first follow-up.

Confidence is high for analytic pairs in general and special position. It is medium for
the near-degenerate band until the two open issues below are closed. B-spline surfaces
are out of scope (`SSI_UNSUPPORTED`).

## Open issues

1. **Near-crossings (`fit < δ ≲ 1e-4`).**
   - What happens: a 4-ended contact cluster near a saddle of `G` is resolved as one
     singular vertex. The actual curves pass by the saddle at ~√(δR), so fitting through
     the vertex fails (`SSI_NOT_CONVERGED`).
   - Fix: pair the ends by pass-throughs that keep the raw orientation of `perp(∇G)`
     (as the fitter now does) before falling back to a vertex.
2. **Tangent bands.**
   - What happens: where the surfaces are within `fit` along a whole arc but not snapped
     by a closed form, the intersection is a thin lens with tips of radius ≈ δ. It is
     slow (3.4 s at δ = 1e-7) or fails (δ = 1e-6).
   - Fix: a ridge tracer on `min |G|` that reports a `Contact::Tangent` branch, which is
     also what the boolean wants.
   - The fitter was hardened for these cases during the spike: a re-trace fallback with
     orientation-locked jump detection, and in-band nodes near off-curve cluster
     vertices.
3. **Pcurve consistency is verified, not certified.** It uses 16 samples per span; the
   3D bound is certified. A Bernstein bound of `S(pcurve(t)) − C(t)` needs rational
   trigonometric forms.
4. **`certified_complete = false`.** It is set when a pass-through or a safety net was
   used (rare in the corpus, common in the near-degenerate sweep). The boolean must
   treat it as a warning.
5. **B-spline surfaces** (`SSI_UNSUPPORTED`). They need parametric–parametric
   subdivision SSI (no implicit form). F1's STEP import will need it.
6. **Performance of closed forms.** Fitting non-affine pcurves on spheres, cones and
   tori (plane–sphere 66 µs) could use cheaper nodes. `forge-core`'s `Interval` would
   benefit from a finite-bounds fast path (the ~40% regression above).
7. **Tolerance-band semantics.** At near-tangential contacts, curve points are within
   `fit` of both surfaces but may lie farther from the *exact* curve (up to
   `fit / sin(angle)`). This is inherent to tolerant SSI; `min_angle` flags it and
   boolean edge tolerances must account for it.
8. **Workspace hygiene outside this crate** (not SSI's to fix): at the time of writing,
   `cargo clippy -p forge-core --all-targets` and `cargo fmt -p forge-core --check`
   report issues in `math.rs`, `scalar/interval.rs` and `topo/validate.rs`, which
   another workstream is editing.
   - Because clippy also lints path dependencies, a plain
     `cargo clippy -p forge-ssi --all-targets -- -D warnings` currently fails on
     `forge-core/src/math.rs` (two `float_cmp`).
   - With `--no-deps`, forge-ssi is clean, and it was clean without the flag before that
     change.
   - `forge-core`'s tests (161, including the 5 `implicit` tests) pass.

## What the boolean implementation needs next

1. **Face-pair driver.** Prune face pairs with bounding boxes / a BVH, and call
   `intersect_surfaces` on each face's parameter box. Then **trim** each branch to the
   actual faces: intersect pcurves with the faces' trim loops in parameter space
   (2D curve–curve intersection with the same certified machinery), and classify the
   pieces with robust point-in-face tests (`forge_core::predicates` on pcurve
   polylines + exact refinement).
2. **Edge–face intersections** with `intersect_curve_surface` for every edge curve type:
   lines, circles, ellipses, the exact rational conics, and the degree-5 fitted
   B-splines SSI produces (supported via the per-knot-span certified search).
3. **Vertex merging.** Triple points where several face pairs meet must become one
   vertex. Use `error_bound`/`linear` as the merge radius, and intersect a branch of
   (A, B) with C to place it consistently.
4. **Topology from the graph.** Use `sense` (`n_a × n_b`) to orient new edges. Split at
   `Singular` and `SurfaceSingularity` vertices (degenerate edges at apexes/poles).
   Split pcurves at seams of periodic surfaces (SSI returns continuous unwrapped
   pcurves).
5. **Tangent and coincident cases.**
   - `Contact::Tangent` branches and `TangentPoint`s decide touch-vs-cross without
     splitting faces.
   - `Coincidence { uv_map, same_orientation }` drives a 2D region boolean in the shared
     parameter space (coplanar / co-cylindrical faces).
6. **Tolerances on the B-rep.** Per-edge tolerance = `error_bound` (≤ 1e-7), per-vertex
   tolerance from the merge. Near-tangency warnings come from `min_angle`.
7. **Error surfacing.** Map `SsiError` codes and diagnostics into the boolean's
   explainable failures. Treat `certified_complete = false` as a flagged result.
8. **Before the DeepCAD replays:** close open issues 1–2 (near-crossings, tangent bands),
   since fillet-heavy models live in that regime. Then run booleans on the 500 DeepCAD
   replays against the OCCT oracle with the same adjudication (truth sampling + closed
   forms).

## Follow-ups

- [ ] Near-crossing pass-through pairing with orientation lock (open issue 1).
- [ ] Tangent-band ridge tracer → `Contact::Tangent` branches (open issue 2).
- [ ] Certified pcurve consistency bound (open issue 3).
- [ ] Parametric–parametric SSI for B-spline surfaces (F1 STEP import).
- [ ] `forge-core` `Interval` fast path (coordinate with the forge-core owner).
- [ ] Boolean spike half: face-pair driver, trimming, classification, DeepCAD replays.
- [ ] Add the OCCT differential run (`ssi_oracle_batch` + `occt_ssi_diff.py`) to CI as a
  nightly job; it caught a regression during this spike.

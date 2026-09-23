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

---

# W4: open issues 1–2 and the booleans (`forge-ops::boolean`)

Workstream W4 of `docs/IR-V1-IMPLEMENTATION-PLAN.md`: close the SSI open issues, then
implement interface I4 (`apply_body_op`) on top of `forge-ssi`.

## SSI open issues

**Issue 1 (near-crossings): closed.**
- Clusters with an even number of branch ends near a saddle of `G` whose value is clearly
  off zero (`|G| > fit/4`) pair their ends by orientation-locked pass-throughs.
- True crossings split every branch that passes within reach of the saddle first
  (`split_at_crossings`), so they become singular vertices.
- Odd clusters without a special point are paired across clusters by a locked hairpin
  trace.
- The equal-cylinders sweep passes for every δ in the release sweep
  (1e-9 … 1e-3, including 2e-8, 1e-7, 1e-6).

**Issue 2 (tangent bands): narrowed, not closed.**
- The sphere-in-cylinder lens now works down to δ = 1e-6; it used to fail below 5e-6.
  - Hairpin tips are traced with a strict corrector that accepts a point only when its
    distance to the curve (`|G|/|∇G|` in 3D) is below `max(1e-12·len, min(h/20, 1e-9·len))`.
  - Before this, a small `|G|` alone let the trace slide along the tolerance band past
    the tip.
- At δ = 2e-8 and 1e-7 the tip radius (≈ δ) is below what rounding allows in the
  distance form, so the result is an explicit `SSI_BUDGET_EXCEEDED` or
  `SSI_TANGENT_UNRESOLVED`.
- The ridge tracer that would report a `Contact::Tangent` branch there is still open. The
  `known_hard` window in `tests/ssi_march.rs` is now `[1e-8, 1e-6)`.

**Other SSI defects the booleans exposed, now fixed.** The first two have regression
tests in `tests/ssi_march.rs`. The crossing and outside-box fixes are pinned by the
boolean regression cases 17:139, 17:391, 23:211, 23:391 and 17:422.
`plane_parallel_to_sphere_axis_has_exact_pcurves` guards the sphere pcurves the boolean
relies on.
- **Loop traced twice.** A closed curve touching the periodic window edge was traced
  around twice (one branch of double length).
  - Cause: the closure test compared canonical period copies of the start and of the
    step, which differ by a period when the start lies on the window edge.
  - Fix: the test now uses the start's period copy nearest to the step. The safety net
    also closes at the most recent lap.
- **NaN at a cone apex.** A cylinder through a cone apex that lies on the cone's domain
  bound produced a zero-length piece and a NaN node (`SSI_NOT_CONVERGED`). Such pieces
  and spans are now skipped.
- **Crossing on the box edge.**
  - An odd cluster at a true crossing on P's box edge (one arm leaves the box there) is
    now a singular vertex.
  - Two ends at a true crossing that meet at an angle (not straight through) now end at
    a vertex; before, they were joined through a kink the fit then rounded.
- **Contact clusters outside Q's box.** These are now ignored: their branch ends stay
  domain ends and are clipped anyway. Before, they were `SSI_TANGENT_UNRESOLVED`.
- **A curve along a parameter-box edge exhausted the clip budget** (review round 2).
  - A cap plane against a side face whose padded box ends exactly on their intersection
    line (a pocket 3e-6 under the cap, padded by 3e-6): the box constraint vanishes along
    the whole line up to rounding, and the clip's root finder (zero tolerance 0) bisected
    it until `SSI_BUDGET_EXCEEDED`.
  - The clip now counts constraint values within `1e-12·(1 + |bound|)` as zero, so such a
    range is a flat (split at its ends, classified by midpoints). Simple crossings are
    isolated by monotonicity first and do not change.
  - Pinned by `ssi_exact::a_plane_pair_meeting_on_the_box_edge_does_not_exhaust_the_budget`
    (fails without the fix); the determinism golden and the differential are unchanged.

**Checks after these changes:**
- `cargo test --release -p forge-ssi`: all pass, including the determinism golden.
- OCCT SSI differential, 2 × 2,400 pairs:

| Seed | Agree | Coincident | OCCT-wrong | Forge-wrong |
|---|---|---|---|---|
| 17 | 2,288 | 20 | 92 | 0 |
| 5 | 2,297 | 21 | 82 | 0 |

Re-run after the review-round-2 clip change: identical counts on both seeds, and the
determinism golden (`0x25d31489fbd5d1e6`) is unchanged.

## Booleans

**API.** `forge_ops::boolean::apply_body_op(op, targets, tools, feature) -> BodyOpResult`.
- `BodyOpResult` holds: bodies with origin/change (canonical order), `untouched`,
  `merged_into`, `removed`, `splits`, notes (`BOOLEAN_SPLIT`, `BOOLEAN_BODY_CONSUMED`),
  face **and edge** key aliases (chains resolved to the final key), and `uncertified`.
- `unify_same_domain` runs after every operation and is also public.
- Errors are `BooleanError` with SPEC codes and details: `BOOLEAN_NO_INTERSECTION`
  `{tool, min_distance}`, `BOOLEAN_EMPTY_RESULT {targets}`, `BOOLEAN_NON_MANIFOLD {probe}`,
  `BOOLEAN_TOOL_IS_TARGET {origin}`.
- Internal failures are `FORGE_BOOLEAN_*` codes: `SSI` (with the SSI message, point,
  measured value and limit), `UNSUPPORTED`, `INCONSISTENT`, `INVALID_RESULT`,
  `NEAR_COINCIDENT {entities, offset, limit, point}` and `NO_OPERANDS {role}`. A failed
  consistency check is an error, never a returned body.

**Several operands (SPEC §6.0.3), review round 2.** The result no longer depends on the
order of `targets` and `tools` (tests compare the bodies bit for bit under permutations).
- **Join.** The overlap graph over all targets and tools (sharing volume or a face of
  positive area; every pair whose boxes meet is tested) gives the connected components of
  `T ∪ K`. A target overlapping another target joins its component (`merged_into`). Each
  component is united in canonical order, each next operand overlapping one already
  united. `BOOLEAN_NO_INTERSECTION` applies per tool against the targets, as the SPEC
  words it: a tool that only overlaps another tool fails in either order. A tool and an
  operand of another component that touch along an edge or at a point make `T ∪ K`
  non-manifold (`BOOLEAN_NON_MANIFOLD`, probe kind edge or vertex). *Review round 3:*
  contacts between two targets existed before the operation and are left as they were,
  whether or not a tool modifies one of them elsewhere (round 2 flagged them once one
  target was modified).
- **Cut.** Each target minus every tool in canonical order. `BOOLEAN_NO_INTERSECTION`
  names the tool closest to the targets.
- **Intersect.** The tools are united into components like a join. Each target is
  intersected with each component. Pieces of one target from different components that
  touch along an edge or at a point are `BOOLEAN_NON_MANIFOLD` (they used to come back as
  a `BOOLEAN_SPLIT`).
- **Unchanged targets.** A target the operation leaves as it was (a nested join tool, an
  intersect tool that contains it) is `untouched`, not `modified`.
- **Empty operand lists** (a `card: any` reference resolving to nothing) are
  `FORGE_BOOLEAN_NO_OPERANDS`. Before, a cut with no tools panicked.
- **`BOOLEAN_TOOL_IS_TARGET`** compares bodies (bit-identical geometry and topology), not
  origins: two pieces of one split body share an origin and may be target and tool.
- **`min_distance`** is exactly 0 when the tool touches a target (known from the
  intersection, e.g. a sphere resting on a face, which has no vertex or edge near the
  contact). Otherwise it is an upper bound: vertices, edge samples and face-grid samples of
  each body against the other's closest points, refined by alternating closest points.

**Canonical order (SPEC §5.4), review round 2.** Pieces of one origin are ordered by
their exact centroid (forge-check mass properties), lexicographically with tolerance
`LINEAR_TOLERANCE·s`. `s` is the diagonal of the operands' box, at least 1. The procedure
is forge-refs' `Scope::canonical`. Before, pieces were ordered by the centre of a sampled
box, compared exactly.

**Pipeline.** Model → imprint → per-face arrangement → classification → assembly → unify.
- **Imprint.**
  - Face pairs are pruned by certified boxes.
  - Edge–face hits and overlaps use `intersect_curve_surface`; face–face branches are
    split at the hits and trimmed by piece middles.
  - Vertices are merged within `LINEAR_TOLERANCE` (the frozen `forge_ir::v1` constant,
    not a local copy) and coincident pieces deduplicated. Pcurves come from the SSI or
    are fitted within 5e-8.
  - Isolated contact points are recorded: SSI tangent points, and isolated surface
    singularities (a cone apex resting on a face). At a singular point of a face's surface
    (apex, pole) the face is located from eight points just off the singular line
    (`Chart::around_singular`), because the parameters there are a whole line outside the
    chart window.
- **Arrangement.** Seam-free charts (ADR 0012) with cut lines, a DCEL, holes attached by
  upward rays, and cut gluing.
- **Classification.** Coincidence gives on-same or on-opposite; otherwise generic-ray
  point-in-solid.
- **Assembly.**
  - Selection per operation.
  - Checks on edge uses, vertex fans, contact points and contact lines
    (→ `BOOLEAN_NON_MANIFOLD`). A contact point counts as kept on a face if any fragment
    around it is kept (at a singular point or on a fragment boundary): conservative, an
    error rather than a body.
  - Shells and voids.
  - Per-edge tolerance covers the SSI `error_bound` and the pcurve deviation.
  - `forge_core::topo::validate`.
- **Unify (§6.0.4).**
  - Faces on one carrier merge.
  - Edges merge at vertices no other edge uses: on one line, circle or ellipse, or pieces
    of one intersection curve (B-splines concatenated exactly, also across a closed
    curve's end).
  - A lone closed edge becomes a ring, unless its pcurve does not close on a face (a
    closed curve through a cone apex or sphere pole keeps its vertex there).
  - Surviving keys follow §5.2 (target entities first, then byte-wise smallest) for faces
    and edges; the other keys are reported as aliases. *Review round 3:* compared and
    reported as SPEC keys (`Provenance::key`, with the cap qualifier), no longer as v0
    display names (see "Review round 3" below).
  - A merge the SPEC requires that cannot be built (pcurve refit, re-traced domain not one
    face, merged edge coedges not consecutive) is `FORGE_BOOLEAN_INCONSISTENT`. Before,
    the faces were silently left unmerged. None of these errors occurs on 4 × 600 corpus
    cases.

**Robustness fixes found by the corpus and the oracle.** Each is pinned by
`boolean_properties::regression_cases_hold` or a unit test.
- **Pcurves at a cone apex or sphere pole.**
  - The end `u` is now extrapolated from the curve, not the projection of rounding noise.
  - The pcurve never crosses to the far side of the singular line.
  - This was the one silently wrong volume the corpus identities caught (0.14 mm³ on a
    103 mm³ join with an exact area). A result is now never returned wrong: the identities
    hold on 4 × 600 cases.
- **Wrapped pieces of closed periodic branches.** Their pcurves are refitted; before,
  they extrapolated B-spline pcurves outside their domain.
- **Chart queries on the cut line.** A point at the window's edge found no crossing.
- **Holes whose top point is a node.** Other upward ray directions are tried.
- **Interior pieces that separate nothing** (tangent contact lines) are dropped from the
  face and recorded as contacts, for the non-manifold check:
  - slits inside a face (same half-edge cycle on both sides);
  - lines across a cylinder band (same output face on both sides).
- **Fragments with degenerate interior points.** Such fragments are reclassified at
  further interior points.
- **Section ends on a boundary edge with no edge–face hit.** They now split that edge
  (the edge only touches the other surface at a section double point).
- **Sphere faces with holes only.** The new pole is placed inside the first hole (the
  widest interval of the hole's parameter polygon) and checked to be enclosed.
- **SPEC §6.0.3 early outs.** A join without overlap, or a cut that changes nothing,
  stops before assembly: `BOOLEAN_NO_INTERSECTION`, even when the bodies touch along an
  edge.

**Review round 2 fixes** (pinned by `tests/boolean_contacts.rs`, `tests/boolean_multi.rs`
and the regression list):
- **Contacts at a sphere pole or cone apex were dropped.** A cut whose cavity touched the
  target's boundary at a pole or apex returned a two-shell body touching itself at a point
  (silently non-manifold; forge-check validates such bodies). Two causes:
  - the imprint located the pole with its parameters, which lie on the chart's singular
    frame line: outside every face;
  - the assembly asked `face_at` there, which also answers "no face".

  Both now look around the singular line. An isolated `SurfaceSingularity` vertex (an apex
  resting on a plane) is a contact point like a tangent point. The reviewer's centred case
  (pole at the face centre), which gave `FORGE_BOOLEAN_INCONSISTENT`, is now
  `BOOLEAN_NON_MANIFOLD` too.
- **Near-coincident faces** (offsets between the SSI coincidence resolution, ~1e-8, and
  about 1e-5) failed as `FORGE_BOOLEAN_INCONSISTENT` or with a pcurve-fit error. They are
  now `FORGE_BOOLEAN_NEAR_COINCIDENT` with the measured offset, from two detectors:
  - a fragment point lying on a parallel face of the other operand without an SSI
    coincidence;
  - two edge pieces judged the same curve (within `10·tol`) that are farther apart than
    their tolerances.

  Sweeps (ε = 1e-10 … 1e-4; boxes, concentric spheres, coaxial cylinders):

  | Configuration | ε giving `NEAR_COINCIDENT` | Everything else |
  |---|---|---|
  | 6 box cases (flush boss, pocket ±ε, intersect, side by side gap/overlap ε) | 3e-8, 1e-7, 5e-7 | valid bodies with the closed-form volume, or `NO_INTERSECTION` for gaps ≥ 1e-6 |
  | Sphere minus a sphere of radius `r − ε` | 3e-8, 1e-7, 3e-7 | valid |
  | Cylinder joined with a coaxial one of radius `r + ε` | 1e-6, 3e-6 | valid |

  Snapping surfaces within `LINEAR_TOLERANCE` to one another (a fuzzy boolean) would close
  this band; that is not done. *Superseded in review round 3:* the detectors caught the
  band only partly (offsets of 6e-7 … 1e-6 were merged or `BOOLEAN_NON_MANIFOLD` depending
  on the sign and the operation). One rule now applies before any intersection (see
  "Review round 3").
- **A closed intersection curve through a cone apex became a ring** whose pcurve ends at
  two points of the apex line. No chart takes that as a loop, so every later boolean on
  the result failed with "operand face domain" (case 23:559's intersection). The vertex
  at the apex now stays, and chained cut and intersect with a box satisfy the identities.
- **Tool-union aliases** of a multi-tool intersect were dropped. Alias chains across the
  steps of a multi-operand operation are now resolved to the final key.

## Verification

**Unit and closed-form tests** (`cargo test --release -p forge-ops`):
- 37 library unit tests: charts (including point location around a singular line), geometry
  helpers, errors (catalogue keys, SSI details with point and measured value), alias
  chains, the tolerant canonical order.
- `tests/boolean_basic.rs` (12):
  - box join, cut and intersect with exact volumes and counts;
  - a cylindrical hole;
  - crossed cylinders against a Simpson closed form (the equal-radius cut is
    non-manifold);
  - coplanar and touching operands, a nested void (a nested join tool leaves the target
    `untouched`), a split;
  - a disjoint tool (`min_distance` 1.5), several targets with `merged_into`, tool = target;
  - edge-touching operands (`BOOLEAN_NO_INTERSECTION` with distance 0).
- `tests/boolean_multi.rs` (12), added in review round 2:
  - four holes in one cut: volume `200 − 8π`, 10 faces, 20 edges, rim keys
    `g/edge:{h0/side:c|p/cap:start}`; all 24 tool orders give bit-identical bodies;
  - overlapping tools: the plate minus the union of two disks;
  - consumed + untouched + cut targets (`removed`, `BOOLEAN_BODY_CONSUMED`, `untouched`);
  - two-tool intersect (union of the tools, 26 mm³, tool order irrelevant); disjoint tools
    split (`BOOLEAN_SPLIT`); tools touching along an edge or at a point:
    `BOOLEAN_NON_MANIFOLD` for intersect and cut, probe kind edge/vertex;
  - join components independent of target order; a tool overlapping only another tool is
    `BOOLEAN_NO_INTERSECTION` in both orders (`min_distance` 1.0); a target touching the
    join result along an edge is `BOOLEAN_NON_MANIFOLD`; targets that already touched,
    away from the tools, stay `untouched`;
  - empty operand lists for all three operations; `BOOLEAN_TOOL_IS_TARGET` with split
    pieces; `min_distance` 0 for a resting sphere, 0.5 and 1.25 above it, and the closest
    of several cut tools;
  - canonical order: an L-shaped piece (centroid x ≈ 2.87, box centre 5) before a square
    (x = 4); a tie in x within the tolerance (1.2e-7) decided by y;
  - keys: split pieces share keys, 6 new `g/vertex:{…}` and 6 `g/edge:{a/…|k/…}` at a
    corner cut, merged faces **and edges** keep the target's keys with tool aliases, and
    tool-union aliases of an intersect.
- `tests/boolean_contacts.rs` (6), added in review round 2:
  - a sphere pole touching a face from inside, 8 positions and 3 axis orientations
    (bottom, top, sides x = 0, x = 4, y = 4, the face centre): cut is
    `BOOLEAN_NON_MANIFOLD` with the contact point as probe, intersect is the sphere;
  - a cone apex resting on a face from inside (4 positions, apex down and up);
  - an intersection pinched at a pole of the tool's void (and the same target lowered by
    0.5: a valid body with the closed-form volume);
  - equator contacts and clear voids unchanged (controls);
  - the near-coincident sweeps above.

**Property tests** (`tests/boolean_properties.rs`):
- The identities `vol(A∪B) + vol(A∩B) = vol A + vol B` and `vol(A−B) + vol(A∩B) = vol A`
  are checked in two populations:
  - **exact geometry** (no B-spline edge or pcurve in the results): within **1e-9
    relative** to `vA + vB`, the plan's bound;
  - **fitted geometry** (an intersection curve or pcurve fitted within the SSI 1e-7 /
    pcurve 5e-8 tolerance): within `1e-9·(vA+vB) + 2e-7 mm × (area of the results with
    fitted edges)`. Their boundary is exact only to the fit tolerance, so 1e-9 relative
    cannot be guaranteed. **Proposed plan amendment** for fitted geometry; the observed
    worst case is 1.1e-8 relative.
- `forge_check::validate` must pass on every result, and semantic codes must be
  consistent. An `untouched` target counts with its own volume.
- Default run: seed 11, 240 cases × 3 operations, plus a same-process rerun and proptest
  boxes (256 cases, exact geometry, 1e-9).
- Regression cases: 16 corpus cases, and a chained cut and intersect on case 23:559's
  intersection.
- Extended run (ignored test): 4 seeds × 600 cases × 3 operations. It found no identity
  violations and no invalid body returned (review round 2 run, 174 s in release).

| Seed | Cases | All three ops OK: exact (worst rel.) / fitted (worst rel.) | Consistent semantic outcomes | Internal errors (ops) |
|---|---|---|---|---|
| 11 | 600 | 84 (9.1e-16) / 266 (1.1e-8) | 243 | 13: 8 torus, 3 × 11:230, 2 × 11:331 |
| 5 | 600 | 80 (7.3e-16) / 302 (8.6e-10) | 212 | 8: 7 torus, 1 × 5:326 |
| 17 | 600 | 83 (8.8e-16) / 290 (4.2e-9) | 225 | 3: torus |
| 23 | 600 | 77 (9.8e-16) / 298 (1.4e-9) | 223 | 3: torus |

The internal errors are the same 27 of 7,200 operations (0.38%) as in round 1. 21 are
torus-unsupported (0.29%) and 6 are other failures (0.08%). No same-domain merge error
(now strict) and no `NEAR_COINCIDENT` occurs in the corpus. Four cases moved from "all
three OK" to "semantic" (seed 11: one, seed 23: three), which is consistent with the new
contact detection. The OCCT differential on seeds 11 and 23 below finds no Forge-wrong
case.

**Internal errors, all explicit:**
- Torus faces that become "torus minus disks": `FORGE_BOOLEAN_UNSUPPORTED`, because
  forge-check cannot measure them.
- One fourth-order tangency (11:230): a rim circle touching a cylinder that is tangent to
  the cap plane. The pseudo-overlap it produces is rejected by the pcurve fit.
- Two false positives of `forge_core::topo::validate`'s `LOOP_ORIENTATION` (11:331,
  5:326): see the integrator notes.

**Determinism of the booleans** (`tests/boolean_golden.rs`, review round 2):
- `corpus::batch_fingerprint(2026, 48)` is FNV-1a over the bit patterns of every result
  body (vertex points and tolerances, edge curves at three parameters, ranges and
  tolerances, face surfaces and senses, pcurves at three parameters per coedge), the
  report fields, and error codes with their measured values.
- Provenance keys are left out: they are pinned by the key tests, and their grammar
  belongs to W3.
- `0xda8d5f9612fcbaa2` is identical on native release, native debug and wasm32-wasip1
  (the test binary built with `cargo +1.92 test --target wasm32-wasip1 --no-run`, run
  under Node's WASI, 0.9 s).
- Not checked yet: x86_64 (no Rosetta or x86_64 std on the reference machine) and
  wasm32-unknown-unknown. libtest needs `Instant` there, so that target needs a
  `harness = false` test or an example with an exported `main`, like forge-ssi's.
  forge-ops has no `examples/`, which is outside this workstream's paths.
- `proptest` is now a native-only dev-dependency of forge-ops (as in forge-ssi) so that
  the golden builds for wasm32.

**OCCT differential** (`tests/boolean_oracle.rs` + `oracle/occt_boolean_diff.py`):
- 4 × 600 random prismatic and revolved pairs (seeds 17 and 5 as in round 1, plus 11 and
  23 in round 2): rectangles, circles, slots, holes, polygons, rotated frames, revolves
  (tori, cones, spheres), coplanar, touching, nested and disjoint. Each case runs one
  operation.
- OCCT: `BRepAlgoAPI_*`, then `ShapeUpgrade_UnifySameDomain`.
- An `untouched` target is part of the geometric result, so the batch lists its body
  with the result bodies.
- Every disagreement is adjudicated:
  - volume **and area** differences by adaptive integration of OCCT's result
    (`VolumePropertiesGK`, `SurfaceProperties` with eps 1e-12). A row is
    `occt_metric_wrong` only when every metric that disagreed agrees with Forge afterwards.
    An area disagreement the adaptive integral does not settle is `undecided_area`. Round
    1 cleared area-only rows by the volume integral alone; the 3 such rows on seed 17
    (184, 230, 256) are now settled by the area integral;
  - then a 64³ grid of the operands' classifiers;
  - codes by SPEC §6.0.3 (join touching = no shared face area);
  - Forge's non-manifold probes by the true result's local topology on small spheres;
  - counts after SPEC §6.0.4 normalization of OCCT's output: seams, internal single-face
    edges at tangent contacts, same-domain faces USD left split across a seam, and pieces
    of one curve split at seams.
- The script reports agreement separately over the **geometric** cases, where both
  engines returned bodies. About a third of the corpus ends in a semantic outcome
  (`BOOLEAN_NO_INTERSECTION`, `BOOLEAN_EMPTY_RESULT`, `BOOLEAN_NON_MANIFOLD`) on either side.

Final code of review round 2:

| Seed | Pairs | Agree | OCCT metric wrong¹ | OCCT wrong² | Forge error³ | Forge wrong | Forge correct | Geometric cases: raw agreement |
|---|---|---|---|---|---|---|---|---|
| 17 | 600 | 579 | 17 | 3 | 1 | 0 | 599 (99.83%) | 406: 95.57% |
| 5 | 600 | 574 | 21 | 3 | 2 | 0 | 598 (99.67%) | 420: 94.76% |
| 11 | 600 | 573 | 20 | 2 | 5 | 0 | 595 (99.17%) | 387: 94.83% |
| 23 | 600 | 580 | 16 | 3⁴ | 1 | 0 | 599 (99.83%) | 413: 95.88% |
| **All** | 2,400 | 2,306 (96.08%) | 74 | 11 | 9 | **0** | 2,391 (99.63%) | 1,626: 95.26% |

¹ OCCT's own fixed-order volume or area integral is off by more than 1e-6 relative. The
adaptive integrals of OCCT's result agree with Forge on every disagreeing metric.

² Three kinds:
- OCCT returned an invalid body (17:471, 5:254).
- OCCT returned as one solid a result that touches itself at a point or along a curve,
  which Forge reports as `BOOLEAN_NON_MANIFOLD` (17:391, 17:415, 5:343, 5:475, 11:271,
  11:488, 23:259, 23:271). Each was confirmed by the local topology probe; the first four
  also by hand in round 1 (planes tangent to a torus's inner equator, and a sphere
  tangent to a box face from inside).
- 23:163 (see ⁴).

³ All explicit: torus minus disks (17:259, 5:223, 11:55, 11:379, 11:547, 23:55), the
fourth-order tangency 11:230, and the `LOOP_ORIENTATION` false positives 11:331 and
5:326.

⁴ 23:163 is a cone-shaped revolve minus a revolved ring. The script says `both_wrong`
because its 64³ grid "truth" (10.38 mm³) is itself far off (both engines: 7.340 mm³; OCCT's
adaptive integral: 7.340110). Adjudicated by hand:
- The operands are symmetric under x → −x (a solid of revolution about Z and one about
  Y), so the two small pieces at x = ±4.705 are congruent.
- Forge's two pieces are identical to all digits (0.0361623826 mm³, 2.48221533 mm²).
- OCCT's piece at −4.705 agrees with Forge to 2e-7; its piece at +4.705 is off by 3.3e-5
  in volume and 4.9e-5 in area, also in the adaptive integrals.
- So OCCT's geometry of that one piece is wrong, not Forge's.

The grid truth is unreliable on thin pieces of revolved operands; it only decides gross
volume disagreements.

23:307 came up as a count mismatch in the first round-2 run (13 edges vs OCCT's 12). A
closed sphere–cylinder section was cut at its closure, and one piece ended an ulp off a
knot of full multiplicity. `nurbs_segment` then inserted a second cluster of knots there;
after the closure shift they rounded to one value, and the concatenation failed. Unify's
fallback silently left two edges. Fixed: cuts snap to knots within rounding (unit test and
regression case), and a failed concatenation is now an error, not a fallback.


**Count differences on the way there, all adjudicated:**
- OCCT artifacts, removed by the normalization:
  - seam-flagged real edges;
  - single-face internal edges at tangent contacts;
  - unmerged same-surface faces.
- Forge defects, fixed:
  - B-spline and ellipse pieces left split at degree-2 vertices;
  - a seam-like contact line across a band;
  - a closed edge that kept its vertex.

**Commands** (from `forge/`; the oracle runs from `oracle/`):

```text
cargo test --release -p forge-ops -p forge-ssi
BOOLEAN_SEEDS=11,5,17,23 BOOLEAN_COUNT=600 cargo test --release -p forge-ops \
    --test boolean_properties corpus_volume_identities_hold_on_more_seeds -- --ignored --nocapture
BOOLEAN_BATCH_OUT=/tmp/b17.jsonl BOOLEAN_SEED=17 BOOLEAN_COUNT=600 cargo test --release \
    -p forge-ops --test boolean_oracle write_boolean_oracle_batch -- --ignored
uv run python ../forge/crates/forge-ops/oracle/occt_boolean_diff.py /tmp/b17.jsonl --out /tmp/r17.json
# one case: BOOLEAN_CASE=17:139 ... --test boolean_properties one_case -- --ignored --nocapture
# chained stress (review round 3; ~1 s per step):
CHAIN_SEEDS=1,2,3,4,5,6 CHAIN_COUNT=15 CHAIN_STEPS=8 cargo test --release -p forge-ops \
    --test boolean_chained chained_operations_on_more_seeds -- --ignored --nocapture
# one chained step: CHAIN_CASE=seed:chain:step:op:steps ... --test boolean_chained chain_case
# determinism golden on wasm32-wasip1 (the `1.92` toolchain has the wasm32 std):
cargo +1.92 test --release -p forge-ops --test boolean_golden --target wasm32-wasip1 --no-run
node crates/forge-ssi/wasm/run_fingerprint.mjs \
    target/wasm32-wasip1/release/deps/boolean_golden-<hash>.wasm   # exit 0 = golden matches
# and on wasm32-unknown-unknown (review round 4; the libtest binary has no imports):
cargo +1.92 test --release -p forge-ops --test boolean_golden --target wasm32-unknown-unknown --no-run
node crates/forge-ssi/wasm/run_libtest_unknown.mjs \
    target/wasm32-unknown-unknown/release/deps/boolean_golden-<hash>.wasm   # a failed test traps
```

## Acceptance vs plan (W4)

The plan's W4 acceptance (`docs/IR-V1-IMPLEMENTATION-PLAN.md`, W4) against what this
workstream can show, **as of review round 4**. W4 stays **open**: the two MATCH gates and the
naming harness have not run (they need forge-regen, W7b and W11), and the literal-§8.3
agreement shows the MATCH gate cannot pass without a §8.3 amendment (CONTRACT ISSUES 1).

| Plan acceptance test | Status | Evidence / what is missing |
|---|---|---|
| ≥ 99.5 % `MATCH` on the DeepCAD join/cut replay subset | **not run: pending** forge-regen (`op`/`targets` on extrude and revolve, the `boolean` feature and `keep_tools` are not wired) and W7b | none yet |
| ≥ 99.5 % `MATCH` on W7b's generated boolean corpus (3 seeds × 2,000), 0 `POTENTIAL_SILENT_WRONG` | **not run: pending** W7b. **Would fail under literal §8.3**: the proxy reaches 82.1 % literal MATCH (74.7 % of the geometric cases) | Proxy: this workstream's differential, 4 × 600 + 400 pairs (round-4 table below); every literal count/type disagreement is explained by the §8.3 normalizations proposed in CONTRACT ISSUES 1, which would lift it to 96.1 %; the rest is OCCT's fixed-order mass properties (3.0 %, CONTRACT ISSUES 10), OCCT failures and Forge's explicit internal errors |
| Proptests `vol(A∪B) = vA + vB − vol(A∩B)`, `vol(A−B) + vol(A∩B) = vA` within 1e-9 relative | **met** (round 4), for exact and fitted geometry alike, asserted at the plan's bound with no widening | 4 × 600 corpus: 1,074 exact cases worst 1.9e-15, 408 fitted worst 2.8e-10; 720 chained steps worst 1.4e-10; 256 proptest box pairs; every fitted result also closes up (`|∬ n dA| / area ≤ 1e-8`, worst 9.6e-9) |
| `forge-check::validate` clean after every operation | **met, and guaranteed**: every result body passes `forge_check` validity and the operation's volume bounds before it is returned (`boolean::guard`) | 4 × 600 corpus, 720 chained steps, the closed-form sweeps, all suites |
| Naming-harness boolean families (W11): ≥ 90 % correct, 0 `SILENT_WRONG` | **not run: pending** W11 | Keys are SPEC keys; forge-refs' own `Scope::key_problems` was run on boolean results (round 4, scratch crate): only the problems of CONTRACT ISSUES 3 and 11 |
| Bit-identical reports on all four targets | **three of four** | Both boolean fingerprints are identical on aarch64-apple-darwin (release and debug), wasm32-wasip1 and wasm32-unknown-unknown (round 4: the libtest binary runs under Node with no imports). **Not run:** x86_64 (no Rosetta or Docker daemon on the reference machine: needs a CI run of `--test boolean_golden`). Report-level determinism needs forge-regen. |

Scope items of the plan's W4 that live outside this workstream's paths and are **open**:
`op`/`targets` on extrude and revolve, the `boolean` feature (§6.4, `keep_tools`), and
filling the I5 report (`bodies`, `removed`, notes, aliases) from `BodyOpResult` in
forge-regen.

Delivered in this workstream: the face-pair driver, trimming, edge–face hits, vertex
merging, seam-free topology, tangent and coincident faces, contact points at singular
points, `unify_same_domain` (strict), identity (origins, `merged_into`, splits, consumed,
untouched, SPEC keys and aliases of faces and edges, cap qualifiers), multi-operand
semantics independent of operand order, per-edge tolerances, a last-line result guard,
and structured errors.

SSI issue 1 is **closed**. Issue 2 is **narrowed** (lenses down to δ = 1e-6); the ridge
tracer is still open, and bands below δ ≈ 1e-6 fail explicitly.

## Open issues (booleans)

1. **Torus minus disks** (`FORGE_BOOLEAN_UNSUPPORTED`). forge-check's domain integrals
   need a band or disk domain (ADR 0012 open issue). About 0.3% of operations in the
   corpus hit this.
2. **`LOOP_ORIENTATION` false positive in `forge_core::topo::validate`.**
   - The rule reads orientation at the lexicographically smallest vertex of a polygon
     sampled at 9 points per edge.
   - An outer loop with a reflex corner next to a long arc (a 245° arc sampled every 30°)
     gives a self-crossing polygon whose smallest vertex is the reflex corner, although
     the signed area has the right sign.
   - The fix belongs to forge-core: use the exact loop area's sign, which is already
     computed for line/arc loops, or sample adaptively.
3. **Degenerate contacts of order ≥ 4** (a rim circle touching a cylinder tangent to the
   cap) give a pseudo-overlap. They fail explicitly.
4. **Tangent bands below δ ≈ 1e-6** (SSI issue 2) fail explicitly.
5. **Near-coincident faces** (round 4: SPEC [R-3]). Aligned faces and near-tangent
   contacts within `LINEAR_TOLERANCE` are snapped onto each other by translating operand B;
   what a translation cannot fix (coaxial cylinders whose radii differ by at most the
   tolerance, conflicting conditions) is `FORGE_BOOLEAN_NEAR_COINCIDENT` with the reason, and
   so are failures that follow from distinct faces closer than 1e-5 mm (curved faces 1e-6 to
   1e-5 mm apart, planes crossing at an angle of 1e-6 rad or less over a 10 mm face).
   Closing those needs a fuzzy boolean (surface substitution with tolerant edges).
6. **Chained operations on results with a closed curve through a cone apex.** Case
   23:559's intersection is now a valid operand, and cut or intersect with a box across
   it works. A box whose face passes near the apex still fails explicitly
   (`FORGE_BOOLEAN_INCONSISTENT`, face split). The arrangement of a face whose loop
   touches the singular line at a vertex needs more work.
7. **Performance.** About 20 ms per operation on the corpus in release, including
   forge-check validation and mass properties in the test. The slowest cases take
   ~1–2 s: sphere and cone pcurve refits and dense chart arrangements.
   - A multi-operand join probes every pair of operands whose boxes meet and then unites
     each component: about twice the work of one pass for many tools on one target.
   - Split pieces cost one forge-check mass-property evaluation each, for the canonical
     order.
   - Round 3: the result guard costs one forge-check analysis per result body and one per
     operand (the 48-case golden batch went from 0.8 s to 2.4 s; the 4 × 600 corpus from
     174 s to 230 s). A chained step (three operations on a grown body) takes about 1 s.
   - Not profiled yet.

## Review round 3

Round 3 reviewers built chains of booleans on Forge's own results and contacts at box
**edges**. They found two silent-wrong classes (an inside-out body, extra closed spheres),
results no later boolean could process, a sphere that failed once split through its axis,
outcomes that depended on the sphere's revolve axis, and keys compared as v0 display
names. Every finding below has a regression test; each root cause is fixed, not guarded
only.

### Root causes and fixes

**1. Inside-out intersection (blocker).** Box ∩ sphere, the sphere centred on a box face
and tangent to the adjacent face at a point of their common edge, returned a body of
volume −0.2618 for the Y and Z revolve axes.
- Cause: the circle `x = 0` on a sphere revolved about Y runs through both poles. Unify
  merged its two halves at a pole vertex (a vertex "no other edge uses") into one ring
  through both poles. Its refitted pcurve slid along the pole line, and the face read as
  inverted.
- Fix (`unify`): edges are never merged at a vertex lying on a singular point (pole, apex)
  of a face that uses them. The vertex stays, as OCCT keeps its degenerate pole edge. Sphere
  faces whose loops pass through a pole vertex are not re-parametrized (they already reach
  the singular line; the re-parametrization turned exact meridians into fitted pcurves:
  a 3/4 sphere came out 3.3e-8 off π).
- Fix (`geom::fit_pcurve`): a curve passing through a singular point *inside* its range is
  an explicit error ("it needs a vertex there"), never a pcurve that slides along the
  singular line.
- Guard (`boolean::guard`, new): every result body passes `forge_check`'s validity (one
  `body_metrics` analysis: face-domain areas, shell orientation, positive volume) and the
  operation's volume bounds `max(vA, vB) ≤ vol(A ∪ B) ≤ vA + vB`, `vA − vB ≤ vol(A − B) ≤ vA`,
  `vol(A ∩ B) ≤ min(vA, vB)` within `1e-7·(vA + vB) + 1e-6 mm × (area A + area B)`. A cut
  result body made of tool faces only (a closed copy of a tool surface) is rejected.
  Failures are `FORGE_BOOLEAN_INVALID_RESULT`.

**2. Chained operations (blocker) and bodies no later boolean could process (major).**
- Cause: a circle touching another face's edge becomes a closed edge whose two ends are
  one vertex (the face's loop passes through that vertex twice). In the next boolean the
  imprint deduplicated "consecutive splits at the same merged vertex" — the edge's own two
  ends — so the edge produced no piece and vanished from both faces. Results: a loopless
  sphere face (an extra closed sphere, reviewer case a), two extra spheres (b), a body of
  negative volume (c), and "inconsistent inside/outside status" for every boolean after a
  boss tangent to an edge.
- Fix (`intersect`): consecutive splits at one vertex are one split only when the curve
  between them is shorter than `10·tol`.
- The chained stress test (below) found four more defects, all fixed:
  - **SSI vertex position (forge-ssi).** `finalize` merges branch ends within `1e-5` and
    kept the first point: a domain end 5e-6 from a sphere pole took the pole's place, so
    the boolean's pole vertex was 5e-6 off and two pole vertices did not merge ("no
    outgoing edge at a singular vertex" when a sphere is cut by two planes through its
    axis). A special point (tangent point, crossing, surface singularity) now keeps its
    exact position when a domain end merges into it.
  - **SSI clip at a pole (forge-ssi).** A great circle through a sphere's poles clipped to
    a plane's box whose edge it only touches was `SSI_TANGENT_UNRESOLVED`: `u` jumps by π
    at the pole, and no interval enclosure of the `u` constraint separates it from zero.
    The exact path now passes the parameters where the carrier passes a pole or apex to
    the clip (`clip_to_patches_around`), which leaves `t ± fit/|C'|` unsearched and splits
    there (pieces are classified at their midpoints as before). `constraint_splits` also
    splits at the reported parameter when a range with the constraint far from zero cannot
    be certified (depth ≤ 8), instead of failing.
  - **Wrapped pieces of closed operand edges.** A closed periodic edge split at its hits
    gives a piece running past the end of the edge's range; its fitted (B-spline) pcurve
    was extrapolated there (u = 7284 on a sphere). Such pcurves are refitted over the piece.
  - **A section through a pole.** A sphere whose pole lies on a cylinder hole's wall: the
    marched sphere–cylinder section passed through the pole as one edge, whose sphere
    pcurve slid along the pole line — areas off by 1.7e-5 mm², the join 2.2e-6 mm³ off while
    cut and intersect were exact (the reviewer's "join refit" observation). Branches get a
    vertex wherever they pass through a singular point of either face.

**3. Parametrization-dependent outcomes (major).** The sphere tangent to the top face at
a point of the box edge was a valid join for axis Y, `BOOLEAN_NON_MANIFOLD` for Z and X, etc.
- Cause: a tangent contact point kept on both sides was always non-manifold. Where it is a
  vertex of the result and lies on the *boundary* of both faces' kept parts, the faces
  around it are exactly its vertex fan, which the fan check has already found to be one
  disk (manifold). Whether the point was a pole, on a meridian, or on the equator changed
  how the conservative rule fired.
- Fix (`assemble`): a kept face passing smoothly through the contact point (the point
  inside it) while the other face is kept there is non-manifold (the point's link has two
  boundary circles); both on the boundary and the point a result vertex: the fan check
  decides; otherwise conservative. Tested for all three revolve axes, all three
  operations and the swapped intersection, and for the non-manifold counterpart (a dome's
  rim touching the inside of a face).

**4. Sphere split through its axis (major).** Fixed by 1 and the SSI vertex position:
hemisphere and quarter sphere (all three operations and all three axes, closed forms), and
a 270° revolve joined with / cut from the full sphere (was "coincident curves at a vertex").

**5. Keys (majors 1 and 2).** `boolean::keys` (new).
- **Stamping.** At entry every operand's caps and end caps of its origin feature without a
  qualifier get `@member` (SPEC §5.2 rules 1 and 4), so the caps of a multi-region sweep
  joined into another body stay distinct (`e2/cap:end@a1`, `e2/cap:end@b1`).
- **Keys inside the boolean.** Edge and vertex sources are turned into face keys at entry;
  inside the boolean every key is `Provenance::key()`. The unify winner rule and all
  aliases use SPEC keys (`e1/cap:end@b1 → e1/cap:end@a1`, `k/cap:end@m → e1/cap:end@a1`),
  never display names.
- **New entities.** New edges and vertices are keyed by the *result* faces around them
  (`G/edge:{A|B}`, `G/vertex:{…}`, the W7b oracle's rule). An operand edge keeps its key
  only if it bounds the same two operand faces as before; a tool rim now between the
  target's face and the tool's side is a new edge (`g/edge:{e2/side:a1|p/cap:end@m}`).
  When unify merges faces, the operation's own new edges and vertices follow the
  surviving face key; every other entity keeps its key (it was not modified), so a source
  may be the key of a merged-away face: an alias.
- **At exit** source keys are written back as display names where the name designates one
  face of the body (the v0 convention; forge-check's `real_body_op_names_its_section_edges_so`
  relies on it), and stay keys where a name would be ambiguous or the face is gone.
- Tests: `boolean_multi::merges_decide_by_key_and_alias_every_merged_key` (the reviewer's
  two-region join with a flush bridge, then a second flush join),
  `caps_of_multi_region_tools_keep_their_member_in_the_target`, and a key-invariant check
  (`key_problems` in the test: caps qualified, edge sources resolvable as faces or aliases,
  keys shared only by split pieces on one carrier) on these and the existing key tests.
  forge-refs is not a dependency of forge-ops (adding it means editing
  `forge-ops/Cargo.toml`, outside this workstream's paths), so forge-refs' own
  `Scope::key_problems` runs in forge-regen (integrator notes).

**6. Near-coincident faces (minor), one rule (`boolean::near`, new).** Before any
intersection, every pair of aligned faces of the two operands (parallel planes;
cylinders, cones, tori with parallel axes; spheres) that overlap is classified by the
offset of their surfaces: `≤ 1e-8` coincident (the SSI's coincidence snap), `(1e-8, 1e-5)`
`FORGE_BOOLEAN_NEAR_COINCIDENT` with the measured offset, `≥ 1e-5` distinct. Same outcome
for join, cut and intersect and for every surface type (was: merged for `+6e-7`,
`BOOLEAN_NON_MANIFOLD` for `−6e-7`, a 1e-6 step face at `1e-6`, pcurve-fit failures for
coaxial cylinders). The message now states the rule. SPEC [R-3] asks for coincidence up to
1e-6 mm, which needs a fuzzy boolean (CONTRACT ISSUES).

**7. Join contacts between targets (minor).** Only contacts that involve a tool make a
join non-manifold; two targets touching were separate bodies touching before the
operation and are left so (the reviewer's configuration now joins; a tool touching a target
along an edge is still `BOOLEAN_NON_MANIFOLD`).

**8. Other minors.**
- `apply_body_op_in_scope(op, targets, tools, feature, scope_scale)` orders split pieces
  with the scope scale of §5.4 (tested: a 3.1e-6 centroid difference is a tie at the
  operands' scale and decides at scale 1).
- Circles and ellipses whose image turns clockwise in every plane face they bound (a boss
  on a side face) get their mirror frame, so their plane pcurves are exact ellipses
  instead of 5e-8 cubic fits (the side boss join was 4e-8 off; now exact).
- Error details: the `BOOLEAN_NON_MANIFOLD` probe and `min_distance` deviations from §7.6 /
  §6.0.3 are documented on the error type (integrator notes).
- The property tests count a degree-1 B-spline pcurve (an exact affine image) as exact
  geometry, not fitted.

### Verification (round 3)

**Tests** (`cargo test --release -p forge-ops -p forge-ssi`, all pass; clippy
`-D warnings` and rustfmt clean on both crates):
- forge-ops: 37 unit tests; `boolean_basic` 12; `boolean_chained` 7 (new: the edge-tangent
  sphere for 3 axes × 3 operations + swapped + sphere − box; the rim touching a face's
  inside; the reviewer's chained cases (a) and a dome for 3 axes, (b) and (c); bosses tangent to an edge with a
  later cut and join; hemisphere / quarter / 270° sphere for 3 axes; the section through a
  pole for 3 axes at 1e-9 relative; the chained stress) plus 3 ignored helpers;
  `boolean_contacts` 7 (new: the near-coincident band as one rule, both signs, 3 operations,
  boxes and coaxial or offset cylinders); `boolean_golden` 2 (new: the chained golden);
  `boolean_multi` 14 (new: merges by key with the reviewer's two-region flush join, caps of
  multi-region tools, join contacts between targets, the scope scale); `boolean_properties`
  4 (+3 ignored). forge-check's `real_body_op_names_its_section_edges_so` and the forge-refs
  suite (which builds forge-ops bodies) still pass.
- forge-ssi: 69 tests (new: `a_great_circle_touching_the_plane_box_edge_is_resolved`); the
  SSI determinism golden (`0x25d31489fbd5d1e6`) is unchanged.

**OCCT SSI differential** after the three forge-ssi changes (vertex position in `finalize`,
`constraint_splits`, `clip_to_patches_around`): identical counts (seed 17: 2,288
agree / 20 coincident / 92 OCCT-wrong / **0 Forge-wrong**; seed 5: 2,297 / 21 / 82 / **0**).

**Chained stress** (`chained_operations_on_more_seeds`, 6 seeds × 15 chains × 8 steps =
720 steps, 2,160 operations on Forge's own results): **0 internal errors, 0 invalid bodies,
0 identity violations**; 494 steps with three bodies (worst residual 2.4e-9 relative,
fitted), 226 with semantic outcomes. Before the round-3 fixes, 4 seeds × 120 steps gave 18
internal errors besides the reviewer's silent-wrong cases. The default test runs 8 × 6 steps
(seed 7).

**Corpus identities** (4 × 600 cases × 3 operations, 230 s): 1,482 cases with three bodies:
**1,074 exact geometry, worst 1.9e-15 relative; 408 fitted, worst 1.6e-9** (round 2:
1.1e-8; case 17:379, a torus segment). A degree-1 B-spline pcurve now counts as exact, which
moved most former "fitted" cases to exact. Internal errors: the same 27 of 7,200 operations
as in rounds 1–2 (21 torus minus disks, 11:230 × 3, the `LOOP_ORIENTATION` false positives
11:331 × 2 and 5:326); no `NEAR_COINCIDENT`, no guard rejection.

**OCCT boolean differential** (4 × 600, script extended in round 3: types compared, literal
§8.3 and normalized comparisons, adjudication of code mismatches in both directions):

| Seed | Agree | OCCT metric wrong | OCCT wrong | Forge error | Both wrong | Forge wrong | Potential silent wrong | Geometric cases | Counts + types: literal §8.3 | normalized |
|---|---|---|---|---|---|---|---|---|---|---|
| 17 | 579 | 17 | 3 | 1 | 0 | **0** | **0** | 406 | 303 (74.6 %) | 388 (95.6 %) |
| 5 | 574 | 21 | 3 | 2 | 0 | **0** | **0** | 420 | 311 (74.0 %) | 398 (94.8 %) |
| 11 | 573 | 20 | 2 | 5 | 0 | **0** | **0** | 387 | 298 (77.0 %) | 367 (94.8 %) |
| 23 | 580 | 16 | 2 | 1 | 1 | **0** | **0** | 413 | 306 (74.1 %) | 396 (95.9 %) |
| **All** | 2,306 (96.1 %) | 74 | 10 | 9 | 1 | **0** | **0** | 1,626 | 1,218 (74.9 %) | 1,549 (95.3 %) |

- Forge correct after adjudication: 2,391 of 2,400 (99.6 %); the 9 Forge errors are the
  explicit internal errors above; the one "both wrong" is 23:163, adjudicated by hand in round
  2 (the grid truth is off; Forge is right).
- The "normalized" column counts rows whose volumes, areas and validity agree and whose
  faces, edges and face/edge **types** agree after this script's normalization; every other
  geometric row is an OCCT metric error (adaptive integrals side with Forge). The 331 rows
  between the two columns are OCCT representation conventions that literal §8.3 does not
  normalize (CONTRACT ISSUES 1): same-surface faces split at a periodic seam, real edges on a
  seam line dropped by v0's seam rule, curve pieces split at seams, and parabola / hyperbola
  edges (Forge: exact rational B-splines).
- Two normalization defects of round 2's script were found and fixed: it merged edges at a
  sphere pole across OCCT's degenerate pole edge (Forge keeps that vertex, as OCCT does), and
  it typed a merged edge by its first piece (OCCT sometimes represents a short piece of a
  B-spline section as a circle arc); a merged edge now has its longest piece's type.

**Determinism.** `GOLDEN_FINGERPRINT = 0x9c535f561a81f74e` (48 corpus cases; changed on
purpose: results are rebuilt with key provenance, which reorders their arenas, and the fixes
above) and the new `GOLDEN_CHAIN_FINGERPRINT = 0x9753c8f81babd865` (4 chains × 5 steps × 3
operations) are identical on aarch64-apple-darwin release and debug and on wasm32-wasip1
(`cargo +1.92 test --release -p forge-ops --test boolean_golden --target wasm32-wasip1
--no-run`, run under Node's WASI: 2 passed, 7.9 s).

### Acceptance vs plan (W4), round 3

See the table in "Acceptance vs plan (W4)" above (updated for round 3): W4 stays open —
the DeepCAD and W7b MATCH gates and the naming harness have not run (they need forge-regen,
W7b and W11), the 1e-9 volume identities are **not met** for fitted geometry, and
determinism is checked on two of the four targets.

### CONTRACT ISSUES (round 3)

1. **§8.3 rule 1 does not re-merge periodic faces split along seams, and §8.3 lacks three
   normalizations the count comparison needs.** With this OCCT build (OCP 7.9.3)
   `ShapeUpgrade_UnifySameDomain(UnifyFaces, UnifyEdges, ConcatBSplines = false)` leaves
   same-surface faces split across a periodic seam, keeps single-face internal edges at
   tangent contacts, and leaves pieces of one intersection curve split at seams. The
   differential reports both comparisons (74.9 % literal vs 95.3 % normalized agreement on the 1,626 geometric pairs of the 4 × 600 differential). W7b's oracle implements §8.3
   literally, so its ≥ 99.5 % gate would see these count/type mismatches on geometric cases
   unless §8.3 adds: (a) faces on one surface sharing an edge are one face; (b) edges with
   the same face on both sides are not counted; (c) edges on one carrier curve, or between
   the same two faces meeting smoothly, at a vertex nothing else uses are one edge; plus
   the type of a merged face or edge is its members' type. Or W7b implements (a)–(c).
2. **§6.0.4 at a surface singularity.** "Edges … meeting at a vertex shared by no other
   edge are merged": at a sphere pole or cone apex no merged edge can have a continuous
   pcurve (seam-free, ADR 0012). Forge keeps the vertex there (OCCT keeps it too: its
   degenerate pole edge shares it). Proposal: "a vertex at a singular point of a face
   that uses both edges counts as shared".
3. **§5.2 rule 3 when a face an entity names disappears.** Forge (and W7b) keep the key of
   an unmodified edge whose adjacent face was merged away (its source is then an alias key)
   and re-key an edge whose adjacent faces changed (`G/edge:{A|B}` from the result faces).
   Vertices keep their keys from the operand even when a face they name was dropped (W7b:
   from OCCT's history). forge-refs' `key_problems` requires every edge and vertex source
   to be a face of the body; it should accept alias keys (the scope's aliases) for edges
   and not apply the rule to operand vertices, or §5.2 must say that such entities are
   re-keyed (then both engines change).
4. **Junction qualifiers (`@c.end`) are derived by forge-refs, not stamped by the sweep.**
   forge-ops cannot render them inside the boolean, so two edges whose keys differ only in
   `@c.end` would be compared as one key by unify. No such merge occurs (junction edges of
   one sweep lie on different lines), but W3 should stamp `Provenance::qualifier` at
   creation so that `Provenance::key()` is complete everywhere.
5. **Merged edges' surviving key.** §6.0.4 "Keys follow §5.2 rule 3": Forge applies the face
   rule to edges (target edges first, then the byte-wise smallest); W7b takes the smallest
   key without the target preference. One must change.
6. **Near-coincident faces.** [R-3] makes faces within 1e-6 mm coincident; Forge resolves
   coincidence to 1e-8 mm and reports `FORGE_BOOLEAN_NEAR_COINCIDENT` for (1e-8, 1e-5) mm
   (one rule, `boolean::near`). OCCT without a fuzzy value treats them as distinct.
   Either §6.0.3 accepts this band as an engine-internal failure (ROBUSTNESS in the diff)
   or a fuzzy boolean is specified.
7. **Three §6.0.3 ambiguities where Forge and W7b differ** (each a `CODE_MISMATCH` or a
   body-count mismatch once W7b's gate runs; the integrator or SPEC owner must decide, and
   one engine changes):
   - (a) merged join targets: Forge `merged_into` (no I5 report field), W7b `removed`.
     Proposal: forge-regen reports `merged_into` origins in `removed`.
   - (b) a join tool overlapping only another tool that overlaps a target: Forge
     `BOOLEAN_NO_INTERSECTION` (the SPEC's literal "any target"), W7b accepts (its
     component contains a target). Tests: `boolean_multi` (both orders).
   - (c) intersect whose target lies inside the tools: Forge `untouched` (not in
     `bodies`), W7b `modified`. §6.0.5 lists bodies "created or modified".
8. **Join contacts between targets** (review round 3): Forge flags only contacts involving
   a tool; §6.0.3 does not say whether pre-existing contacts between two targets make
   `T ∪ K` non-manifold. W7b fuses all targets and tools and checks each result solid, so
   it depends on how OCCT's fuse represents two targets touching along an edge.
9. **Volume identities within 1e-9 relative** (plan, W4 acceptance) cannot hold for results
   bounded by fitted curves: the SSI fits intersection curves within 1e-7 mm and pcurves
   within 5e-8 mm. Forge meets 1e-9 on exact geometry; fitted cases reach 1.6e-9 (corpus) and 2.4e-9 (chained)
   relative. The plan owner must amend the criterion (proposal: `1e-9·(vA + vB) + 2e-7 mm
   × area of results with fitted curves`) or require tighter fits.
10. Carried over from round 2: OCCT's fixed-order Gauss mass properties are off by more than
   1e-6 relative on ~3 % of the corpus pairs (curved faces trimmed by approximated curves),
   which §8.2's tolerances would class as `POTENTIAL_SILENT_WRONG` with Forge right; the
   `LOOP_ORIENTATION` false positive of `forge_core::topo::validate`; the canonical-order
   scale (now `apply_body_op_in_scope`).


### Integrator notes (round 3)

- **Keys.** `BodyOpResult.aliases` are SPEC §5.2 keys (`Provenance::key`, cap qualifiers
  included): pass them to `ScopeBuilder::alias` unchanged. Result bodies carry edge and vertex
  sources as face display names where that is unambiguous and as face keys otherwise (an
  ambiguous name, or a face merged away); forge-refs' `body_keys` reads both. Keys in
  sources are rendered from the stamped feature segment: provenance must be stamped with
  feature **ids** (v1), not mapped through `provenance_feature`.
- **Cap qualifiers.** The boolean stamps `@member` on its operands' unqualified caps and end
  caps of their origin feature (idempotent). W3 may also stamp them at creation; stamping
  junction qualifiers `@c.end` at creation would make `Provenance::key()` complete everywhere
  (CONTRACT ISSUES 4).
- **forge-refs' `Scope::key_problems`** after every boolean (the W3 contract): expect
  "source … is not a face of the body" for unmodified edges next to a merged-away face (the
  source is an alias key) and for operand vertices next to a dropped face (CONTRACT ISSUES
  3). forge-ops' tests check the same invariant with alias-aware edge sources
  (`boolean_multi::key_problems`); forge-refs is not a dependency of forge-ops (its
  `Cargo.toml` is outside W4's paths).
- **Canonical order.** Call `apply_body_op_in_scope(.., scope.scale())` so that split pieces
  order as `Scope::canonical` orders them (or re-sort `bodies` with `Scope::canonical`).
- **Report.** `merged_into` has no I5 field: report those origins in `removed` (as W7b does;
  CONTRACT ISSUES 7a). `untouched` targets are not in `bodies`.
- **Errors.** The `BOOLEAN_NON_MANIFOLD` probe and `min_distance` deviations from §7.6 /
  §6.0.3 are documented on `BooleanError` (probe: the contact edge piece's parameter middle or
  the contact vertex, `normal: None`; `min_distance`: 0 when touching, else an upper bound).
  `FORGE_BOOLEAN_NEAR_COINCIDENT` covers aligned overlapping faces offset by (1e-8, 1e-5) mm.
  `FORGE_BOOLEAN_INVALID_RESULT` now also reports a result that fails forge-check or the
  operation's volume bounds (never observed after the round-3 fixes).
- **Determinism targets.** Run `cargo test --release -p forge-ops --test boolean_golden` on
  an x86_64 runner. For wasm32-unknown-unknown add a `harness = false` test (or an example)
  to forge-ops that calls `corpus::batch_fingerprint(FINGERPRINT_SEED, FINGERPRINT_CASES)` and
  `corpus::chain_fingerprint(CHAIN_FINGERPRINT…)` and compares them with the golden
  constants; forge-ssi's `wasm/run_unknown.mjs` runs such a module.
- **Performance.** The result guard costs one forge-check analysis per result body and per
  operand (the corpus runs about 30 % slower); forge-regen computes body metrics for the
  report anyway and could pass them in if this matters.
- **W7b.** The differential script's normalized comparison (`normalized_counts`) is a
  proposal for §8.3; see CONTRACT ISSUES 1 for the gate exposure under literal §8.3.


## Review round 4

Round 4 reviewers found that the literal-§8.3 agreement (the gate's measure) was not the
headline, that the 1e-9 volume identities were met only because the tests widened the bound
for fitted geometry, that determinism was checked on two of four targets, that faces within
`LINEAR_TOLERANCE` failed instead of being coincident ([R-3]), that forge-refs' own key
checker had never run on boolean output, three cross-engine divergences, a join that failed
when a tangent section's double point or crossing lay on a sphere pole (57 of 108
configurations), a valid hollow-tool cut rejected by a round-3 check, near-coincident cases
with mixed error codes and misleading offsets, a 1e-6 mm sliver returned silently, a guard
that skipped its check silently, and property tests that could not see these defects.

### Root causes and fixes

**1. Volume identities at 1e-9 (blocker): the bodies did not close up.** The residuals were
not the SSI's fit error as round 3 assumed: `vol(A ∪ B) + vol(A ∩ B) − vA − vB` cancels any
consistent partition of the operands' faces, however approximate.
- Evidence (case 23:163, residual 1.4e-9): the **area** identity held to 0 while the volume
  one did not; exact knot insertion in every pcurve (identical geometry, finer quadrature)
  moved the volumes by 1e-15, so forge-check's quadrature was not it; moving forge-check's
  reference point (the body's box centre) 1000 mm away by adding a far sphere changed the
  join's volume by 1.3e-4 mm³ while the operands changed by 1e-11. The divergence theorem
  gives `ΔV = −Δc · (∬ n dA)/3`: the results had a vector area of ~4e-7 mm², i.e. their faces
  did not close up. The per-edge `½ ∮ x × dx` defect sat on the section edges, whose two
  pcurve images, each fitted independently to the fitted curve within 5e-8 mm, parted by up
  to 5.8e-8 mm between samples. With each result measured about its own box centre, the
  identities failed by ~1e-9 relative. Refits in only some results (a sphere face moved to
  another pole, merged faces, mirrored conics) also changed the partition itself.
- Fixes (`geom`, `intersect`, `unify`, `assemble`):
  - pcurves are fitted to the **surface projection** of their curve within
    `PCURVE_FIT = 1e-10` mm (the target is the projection, so the curve's own distance from
    the surface no longer limits the fit), by C⁰ quintic pieces interpolating at
    Chebyshev–Lobatto nodes (error ~h⁶: fewer control points than round 3's 5e-8 cubic
    fits), with the round-3 cubic fit as a fallback where it cannot converge (a fitted section
    passing a pole or apex at a small offset);
  - fitted **section** pieces get pcurves on the **true intersection** of their two faces
    (Newton on both surfaces in the curve's normal plane, `geom::meet`) where the surfaces
    meet transversally along the whole piece: both faces then close up to ~1e-10 mm however
    far the fitted curve lies from them (the SSI's contract is 1e-7 mm; 1e-8 is common);
  - a pcurve moved to another parametrization of its carrier (merged faces, a sphere face
    re-parametrized) reproduces its **old image** within 1e-10 mm (`geom::refit_pcurve`, exact
    chain-rule derivatives), and sub-ranges of B-spline pcurves are cut exactly (knot
    insertion) instead of refitted, so every result integrates the same boundaries;
  - a consistency failure is retried once with the SSI's own section pcurves (two corpus
    cases whose near-tangent arrangement reads differently with the moved boundaries).
- The property tests now assert the plan's 1e-9 relative bound for every case, and check that
  every result with fitted boundaries closes up (`|∬ n dA| / area ≤ 1e-8`, measured by moving
  forge-check's reference point); the chained test uses 1e-9 too.

**2. Sphere poles in joins (major).** Three defects, all fixed:
- A section vertex placed exactly at a pole, but the fitted curve passing it 2.4e-8 mm away:
  its pcurve ended 6e-9 rad off the pole line, forge-check did not treat the join as singular
  and closed the loop the wrong way round (the windows instead of the face: −36.53 mm², the
  Viviani window area). Curve ends within `LINEAR_TOLERANCE` of a singular point now end
  exactly on the singular line (`u` the limit along the curve, the end tangent the secant).
- The figure-eight section with its double point on a pole: every loop end of the outside
  face lies on that pole; forge-check's band reading takes the singular line beyond the
  highest loop **end point** (`domain::band_singular_v`), i.e. that pole, and integrated the
  complement (−11.6 mm²). Such faces are now re-parametrized (a forge-check note for the
  integrator: its band reading should use the pieces' extent, not their end points).
- The re-parametrization picked the new pole from the old `(u, v)` and its antipode could
  land on the section ("passes through a singular point at t = 10.17"). The pole is now
  chosen in 3D (`unify::reparametrize_sphere`): among fixed candidates (a Fibonacci lattice,
  loop means, hole points), a point outside the face, away from every loop together with its
  antipode, classified by winding numbers of the loops' stereographic projections
  (`W(q) = [q ∈ face] − [−q ∈ face]`, and against a known outside point when that is 0).
  The outcome no longer depends on the axis the sphere was revolved about.
- Regression (`boolean_closed_forms`): the reviewer's sweep, 3 radii (R/4, R/2, 3R/4) ×
  3 sphere axes × 3 cylinder axes × 2 offset directions × 2 signs = 108 configurations, each
  joined and intersected both ways against the closed form
  `(2/3) ∫ [(R² − ρ₁²)^{3/2} − (R² − ρ₂²)^{3/2}] dθ` (Viviani's `(2/3)(π − 4/3)R³` for R/2),
  worst 2.3e-10 relative, and cut both ways `BOOLEAN_NON_MANIFOLD` (the material pinches at
  the tangent point).

**3. A cut by a hollow tool (major).** The round-3 check rejected every cut result body made
of tool faces only. Such a body is valid when those faces bound a **void** of the tool (the
material inside the cavity); the check now rejects only faces of the tool's outer shell
(`model`: a shell whose box lies strictly inside another shell's box is a void). Box
`[0, 10]³` − hollow ball (3 minus 2) = two bodies, 886.903 + 33.510 mm³, `BOOLEAN_SPLIT`, for
every sphere axis; plus a hollow target, a box with a spherical cavity as target, and a
drilled hollow ball (closed forms).

**4. SPEC [R-3] near-coincidence (major), `boolean::near`.** Aligned faces (parallel planes;
cylinders, cones and tori with parallel axes; spheres) **and near-tangent contacts**
(plane–cylinder, plane–sphere, sphere–sphere, cylinder–cylinder with parallel axes,
sphere–cylinder) within the tolerance are made exactly coincident or tangent by translating
operand B by the minimum-norm translation that meets every pair's condition (pairs already
exact are kept so; `|T| ≤ √3·tol`). What no translation fixes (radii or angles that differ
within the tolerance, conflicting conditions) is `FORGE_BOOLEAN_NEAR_COINCIDENT` with a
reason. Faces farther apart are computed as distinct; a failure that follows from distinct
faces staying within 1e-5 mm over their overlap (or a near-tangent contact within it) is
reported as `FORGE_BOOLEAN_NEAR_COINCIDENT` with the largest separation over the overlap
and, when they cross, the angle. The reviewer's configurations (`boolean_contacts`):

| Configuration | Round 3 | Round 4 |
|---|---|---|
| Box face offset `d`, `|d| ≤ 1e-6` | `NEAR_COINCIDENT` | coincident: the coincident result within `|d| × area` |
| Box face offset `1e-6 < |d| < 1e-5` | `NEAR_COINCIDENT` | distinct: exact volumes |
| Coaxial cylinders, radii differing by ≤ 1e-6 | `NEAR_COINCIDENT` | `NEAR_COINCIDENT` ("no translation makes them one surface") |
| Equal cylinders, axes ≤ 1e-6 apart | `NEAR_COINCIDENT` | coincident (snapped) |
| Curved faces 1e-6 to 1e-5 mm apart | `NEAR_COINCIDENT` | `NEAR_COINCIDENT` ("closer than the boolean can separate") |
| Tilted slab, `t = 1e-7, 1e-6` rad | `INCONSISTENT` | `NEAR_COINCIDENT` ("cross at 1e-7 rad") |
| Tilted slab, `t = 1e-5 … 3e-4` | `NEAR_COINCIDENT` | exact wedge `125 tan t` |
| Cylinder or sphere dipping `h ≤ 1e-6` (every axis) | `INCONSISTENT` / `NEAR_COINCIDENT` | a tangency: no intersection / empty |
| Dipping `h = 2e-6, 1e-5` | mixed | exact volume, or `NEAR_COINCIDENT` (sphere joins about X and Y) |
| The 1e-6 mm sliver (round-4 finding 15) | a 2-face body, volume 33 % low | empty (a tangency) |

A result body thinner than the tolerance (mean thickness `2V/A ≤ tol/2`) is degenerate and
dropped (an intersection or cut left with nothing is empty or consumes the target).

**5. Other findings.**
- Intersect whose target lies inside the tools (divergence 7a): the target is its own
  intersection, reported in `bodies` as `modified` (SPEC §6.0.3 intersects every target,
  §6.0.5 lists modified bodies; W7b reports it so).
- The volume guard (findings 9, 16): an operand forge-check cannot measure keeps the
  one-sided bounds of the measured operand and marks the result `uncertified`.
- `FORGE_BOOLEAN_NEAR_COINCIDENT` details (finding 14): `offset` is the largest separation
  sampled over the overlap of both faces, and a `reason` states the case and, for crossing
  faces, the angle.
- Tests (finding 17): closed-form sweeps over the sphere axis for the Viviani and
  napkin-ring families, spheres and cylinders on planes and caps (tangent and dipping),
  voids; expected semantic codes asserted where known; the chained stress test's
  internal-error allowance defaults to 0.
- Determinism (finding 3): the golden test's libtest binary runs on
  wasm32-unknown-unknown under Node (no imports; a failed test traps; negative control
  checked), so no `Cargo.toml` change is needed (`forge-ssi/wasm/run_libtest_unknown.mjs`).
- Differential (finding 1): the literal-§8.3 MATCH rate is the headline, every literal
  non-MATCH is broken down by reason, and every count/type disagreement by the smallest set
  of proposed normalizations that explains it.

### Not changed, with evidence

- **Key invariant (finding 5).** forge-refs' own `Scope::key_problems` was run on boolean
  results from a scratch crate (not committed; forge-refs is not a forge-ops dependency):
  5 targeted scenarios (flush boss, corner boss, coplanar extension, pocket, flush notch) and
  200 corpus cases × 3 operations. Its problems are exactly: sources that are merged-away face
  keys (231: an unmodified edge or vertex next to a face merged into another, CONTRACT ISSUES
  3), operand vertices naming faces the operation dropped (same issue), and "N edges of one
  body share the key on different carriers" — two intersection curves between the same two
  faces both get `G/edge:{A|B}` (new CONTRACT ISSUE 11). W7b follows the same rules, so
  changing Forge alone would turn agreement into `REF_MISMATCH`.
- **Join tool overlapping only another tool (7b)**: Forge keeps the literal §6.0.3 reading
  (`BOOLEAN_NO_INTERSECTION`). **Merged join targets (7c)**: `merged_into` is I4's field;
  forge-regen reports those origins in `removed`. **Surviving key of merged edges**: Forge
  applies §5.2 rule 3's face rule (§6.0.4: "Keys follow §5.2 rule 3"); W7b's smallest-key
  rule should align.
- **§6.0.4 at singular points (finding 7)**, **`min_distance` (finding 8)**: unchanged; the
  vertex at a pole matches OCCT's counts, and `min_distance` is a documented local-minimum
  upper bound (a certified minimum needs a branch-and-bound over trimmed faces; details are
  not compared by §8.2).
- **Conformance fixtures (finding 10)**: `corpus/v1/conformance` is frozen and outside W4's
  paths; boolean outcome fixtures are for the integrator (append-only).

### Verification (round 4)

**Tests** (`cargo test --release -p forge-ops -p forge-ssi`, all pass; clippy `-D warnings`
and rustfmt clean on both crates; forge-check and forge-refs suites pass):
- forge-ops: 37 unit tests; `boolean_basic` 12; `boolean_chained` 7 (+3 ignored);
  `boolean_closed_forms` 7 (new: Viviani family 108 configurations × 6 operations, napkin
  rings, spheres on planes, cylinders on planes, spheres on caps and sides, voids — all over
  the sphere axis; debug builds run a subset); `boolean_contacts` 8 (new: near-tangent and
  small-angle contacts; the [R-3] band rewritten); `boolean_golden` 2; `boolean_multi` 14;
  `boolean_properties` 4 (+5 ignored helpers; 1e-9 bound and the closure check);
  `corpus_topology` 8; `regions` 11; `topology_details` 7.
- forge-ssi: unchanged code (a new Node runner only); 69 tests pass, the SSI determinism
  golden is unchanged (`0x25d31489fbd5d1e6`), and the OCCT SSI differential rerun gives the
  round-3 counts (seed 17: 2,288 agree / 20 coincident / 92 OCCT-wrong / **0 Forge-wrong**;
  seed 5: 2,297 / 21 / 82 / **0**).

**Corpus identities** (4 × 600 cases × 3 operations, `corpus_volume_identities_hold_on_more_seeds`):
1,074 cases with exact geometry, worst 1.9e-15; 408 with fitted boundaries, worst
**2.8e-10** (round 3: 1.6e-9, asserted against a widened bound); every fitted result closes up
(`|∬ n dA| / area` worst 9.6e-9); internal errors: the same 27 of 7,200 operations as in
rounds 1–3 (21 torus minus disks, 11:230 × 3, the `LOOP_ORIENTATION` false positive × 3).

**Chained stress** (6 seeds × 15 chains × 8 steps = 720 steps, 2,160 operations,
internal-error allowance 0): 0 internal errors, 494 steps with three bodies, worst identity
residual **1.4e-10** (round 3: 2.4e-9), 226 with semantic outcomes.

**OCCT boolean differential** (4 × 600 + the reviewer's seed 31 × 400 = 2,800 cases; the
headline is the literal §8.3 MATCH):

| Seed | Literal §8.3 MATCH | of geometric cases | Normalized agreement | OCCT metric wrong | OCCT wrong | Forge error | Forge wrong | Potential silent wrong |
|---|---|---|---|---|---|---|---|---|
| 17 | 494 / 600 (82.3 %) | 303 / 406 (74.6 %) | 579 | 17 | 3 | 1 | **0** | **0** |
| 5 | 487 / 600 (81.2 %) | 311 / 420 (74.0 %) | 574 | 21 | 3 | 2 | **0** | **0** |
| 11 | 504 / 600 (84.0 %) | 298 / 387 (77.0 %) | 573 | 20 | 2 | 5 | **0** | **0** |
| 23 | 490 / 600 (81.7 %) | 306 / 413 (74.1 %) | 580 | 16 | 2 | 1 | **0** | **0** |
| 31 | 325 / 400 (81.3 %) | 200 / 271 (73.8 %) | 385 | 11 | 1 | 3 | **0** | **0** |
| **All** | **2,300 / 2,800 (82.1 %)** | 1,418 / 1,897 (74.7 %) | 2,691 (96.1 %) | 85 | 11 | 12 | **0** | **0** |

The 500 literal non-MATCH cases by reason:

| Reason | Cases |
|---|---|
| Counts/types, explained by `merge_edges` alone (OCCT leaves pieces of one curve split: `ConcatBSplines = false`, curves split at the seams of periodic faces) | 325 |
| … by `seam_real_edges` (v0's seam rule drops a real edge closed on one of its faces) | 18 |
| … by `seam_faces` + `merge_edges` (faces split along a seam: what rule 1 says USD does) | 15 |
| … by `merge_edges` + `conic_bspline` | 11 |
| … by `internal_edges` + `merge_edges` | 10 |
| … by `conic_bspline` (parabola/hyperbola vs Forge's exact rational B-spline) | 7 |
| … by other combinations of the above | 6 |
| Volume or area outside §8.2's tolerance on OCCT's side (fixed-order Gauss; the adaptive integral agrees with Forge) | 85 |
| Forge's explicit internal errors (torus minus disks, `LOOP_ORIENTATION`, 11:230) | 12 |
| OCCT wrong (invalid bodies, a missed non-manifold contact; adjudicated by local topology) | 11 |
| Both off (23:163: Forge right, the grid truth off, adjudicated by hand in round 2) | 1 |

No count/type disagreement is unexplained. With the proposed normalizations §8.3 would give
96.1 %; the rest is OCCT's mass properties (CONTRACT ISSUES 10), OCCT failures and 12
explicit Forge errors (0.43 %). Forge correct after adjudication: 2,787 of 2,800 (99.5 %).

**Determinism.** `GOLDEN_FINGERPRINT = 0xd494c53bc1798632` and
`GOLDEN_CHAIN_FINGERPRINT = 0xa579d6c1ccb6336a` (changed on purpose: the fits and snaps
above) are identical on aarch64-apple-darwin release and debug, wasm32-wasip1 and
**wasm32-unknown-unknown**. x86_64 needs a CI runner.

**Performance** (release, reference machine): the 48-case golden batch 2.95 s (round 3:
2.4 s); the 4 × 600 corpus without the closure checks 139 s (round 3: 230 s; the quintic fits
have fewer control points than the round-3 cubics); the 720 chained steps 250 s (round 3:
~1 s per step).

### CONTRACT ISSUES (round 4)

1. **§8.3 normalizations** (blocker for the MATCH gate). Literal §8.3 gives 82.1 % MATCH
   (74.7 % of geometric cases) on 2,800 pairs; every count/type disagreement is explained by
   five normalizations: `merge_edges` (362 cases in all), `seam_real_edges` (21),
   `seam_faces` (16), `internal_edges` (11), `conic_bspline` (20). §8.3 rule 1 already says
   USD "also re-merges periodic faces that OCCT split along seams": an oracle implementing
   rule 1 **as written** must add `seam_faces` itself (OCP 7.9.3's USD does not). The others
   need an amendment; `merge_edges` in particular is §6.0.4's own rule, which rule 1's
   `ConcatBSplines = false` prevents OCCT from applying: the SPEC is inconsistent there.
   Proposed text: the script's `STEPS` docstring (`forge-ops/oracle/occt_boolean_diff.py`).
2. §6.0.4 at a surface singularity (unchanged from round 3).
3. §5.2 rule 3 when a face an entity names disappears (unchanged; now with forge-refs'
   own checker as evidence: 231 alias sources and the vertex cases).
4. Junction qualifiers stamped by the sweep (unchanged).
5. Merged edges' surviving key: Forge target-first, W7b smallest (unchanged).
6. **[R-3] vs §8.3 rule 2.** Forge now follows [R-3] for faces offset by a translation within
   the tolerance (and near-tangent contacts): it snaps the tool. The oracle has no fuzzy value
   (rule 2), so it computes the unsnapped configuration (a sliver or a gap): those cases
   will differ between engines by design. Faces within the tolerance that differ in radius or
   angle remain `FORGE_BOOLEAN_NEAR_COINCIDENT`. The SPEC should say how the oracle treats
   [R-3] coincidence (a fuzzy value of *tol*, or classing such cases as `ROBUSTNESS`).
7. (a) resolved in Forge (intersect target inside the tools is `modified`); (b) and (c)
   remain as in round 3.
8. Join contacts between targets (unchanged).
9. Volume identities within 1e-9: **resolved** without an amendment.
10. OCCT's fixed-order Gauss mass properties: 85 of 2,800 cases (3.0 %) fall outside §8.2's
    volume/area tolerance on OCCT's side, which a gate would class `POTENTIAL_SILENT_WRONG`
    with Forge right; §8.3's "fixed-order Gauss mass properties" should become adaptive
    (`VolumePropertiesGK` / `SurfaceProperties` with a small `eps` settle all 85).
11. **New: two intersection curves between the same two faces share `G/edge:{A|B}`** (a
    plane cutting a cylinder along two generators, two circles): §5.2 rule 3 gives them one
    key, which forge-refs' invariant rejects ("share the key on different carriers") and rule
    6's display indices reserve for split pieces. The grammar needs a disambiguator (or rule
    6 must cover them).

### Integrator notes (round 4)

- `BodyOpResult`: an intersect never leaves a target `untouched` (a target inside the tools
  is in `bodies`, `modified`); `uncertified` is also set when an operand could not be
  measured (the guard then checks one-sided bounds only).
- `FORGE_BOOLEAN_NEAR_COINCIDENT` details gain `reason`; `offset` is the largest separation
  over the overlap.
- [R-3]: Forge may translate a tool by up to √3·1e-6 mm to make faces coincident or tangent
  (never a target); the reported tool-derived geometry moves by that much.
- forge-check: `domain::band_singular_v` reads a band's singular line from piece **end
  points**; a face whose loop ends all lie on one singular line is read as its complement.
  Forge re-parametrizes such sphere faces; forge-check's owner should use the pieces' extent.
- Run `--test boolean_golden` on an x86_64 CI runner; the wasm32 runs are in the commands
  above (no `Cargo.toml` change).
- forge-refs' `Scope::key_problems` after every boolean will report the classes above (3 and
  11); everything else it checks is clean on the corpus.
- W7b: the differential's `STEPS` are the proposed §8.3 normalizations; `seam_faces` is
  already required by rule 1's text.

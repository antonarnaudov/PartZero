# Forge: the AI-native kernel

Forge is our own geometry kernel and engine. It is written in Rust and ships as native code (napi-rs, C ABI/Swift FFI) and as `wasm32-unknown-unknown`, without Emscripten.

- **Why we build it:** [ADR 0000](adr/0000-own-the-core.md), [ADR 0003](adr/0003-forge-kernel-with-occt-oracle.md).
- **Why Rust:** [ADR 0002](adr/0002-languages-by-purpose.md).
- **Normative IR v0 semantics:** [forge/crates/forge-ir/SPEC.md](../forge/crates/forge-ir/SPEC.md). Both Forge and the OCCT oracle implement exactly that spec. When they disagree, first decide which engine violates the spec. If the spec is ambiguous, fix the spec first.

**Contents:**
- [Crate map](#crate-map)
- [What makes Forge AI-native](#what-makes-forge-ai-native)
- [Topology model](#topology-model)
- [Numerics policy](#numerics-policy)
- [Verification machine](#verification-machine)
- [Milestones](#milestones)
- [Design rules](#design-rules)

---

## Crate map

The crates form the `forge/` Cargo workspace. "Lands in" gives the first milestone or spike that needs each crate.

| Crate | Contents | Lands in |
|---|---|---|
| `forge-core` | <ul><li>**Topology:** half-edge B-rep with native provenance, stored in arenas with typed generational IDs (no pointer graphs).</li><li>**Numerics:** all numeric code is generic over a `Scalar` trait (f64 / Interval / Dual / Rational).</li><li>**Geometry:** analytic curves and surfaces (line, circle, ellipse, plane, cylinder, cone, sphere, torus), linear-extrusion and revolution surfaces, B-spline/NURBS curves and surfaces.</li><li>**Robust numerics:** Shewchuk-style adaptive exact predicates, interval arithmetic, exact rationals for analytic cases.</li><li>**Verification:** critical predicates and invariants are verified with Kani/Verus.</li></ul> | F0 |
| `forge-ir` | Feature-Graph IR types (serde + schemars). They are the JSON Schema contract with TypeScript and the oracle, and come with the normative [SPEC](../forge/crates/forge-ir/SPEC.md). | **Exists** (IR v0) |
| `forge-ssi` | <ul><li>Surface–surface and curve–surface intersection.</li><li>Closed-form solutions for analytic pairs.</li><li>Certified marching (interval-verified) with B-spline fitting of the intersection curve for the general case.</li><li>Tangency and degeneracy classification.</li></ul> | Spike 3 → F1 |
| `forge-ops` | <ul><li>Planar regions from sketches, extrude, revolve.</li><li>Booleans (fuse, cut, common, split).</li><li>Fillet and chamfer: rolling-ball blends, analytic where possible and NURBS blends otherwise, with vertex blends and setbacks.</li><li>Shell and offset, draft, patterns, transforms.</li><li>Later: sweep, loft, thicken, variable blends, sheet metal.</li></ul> | F0 → F3 |
| `forge-mesh` | <ul><li>Watertight B-rep-aware tessellation.</li><li>Mesh bodies.</li><li>SubD (Catmull–Clark limit evaluation) and SDF/implicit bodies.</li><li>Mesh↔B-rep bridges.</li></ul> | F0 (tessellation), F4 (SubD/mesh/SDF) |
| `forge-solve` | Sketch and assembly solvers ([ADR 0008](adr/0008-own-solvers.md)) | Spike 4 |
| `forge-regen` | IR evaluation, expressions, query engine, caching | F0 |
| `forge-check` | <ul><li>Validity and invariant checkers.</li><li>Mass properties.</li><li>Distance and clearance; interference.</li><li>DFM analyses: overhang, wall thickness via distance fields, minimum feature size, sharp internal corners for CNC.</li></ul> | F0 |
| `forge-io` | <ul><li>Our own STEP AP214/242 reader and writer.</li><li>3MF, STL, OBJ, glTF, DXF/SVG.</li><li>Later: HLR (hidden-line removal) for drawings.</li></ul> | F0 (STL/3MF), F1 (STEP) |
| `forge-render` | The wgpu renderer ([ADR 0007](adr/0007-own-renderer-wgpu.md)) | Spike 5 |
| `forge-cli` | The `aicad` binary: headless eval, export and metrics. It is the harness for coding agents and CI. | F0 |
| `forge-napi`, `forge-wasm`, `forge-ffi` | Bindings for Node/Electron, the web, and Swift/iPad | F0 (napi, wasm); Phase 6+ (ffi) |
| `forge-sim` | Differentiable FEA, validated against CalculiX | F5 |

---

## What makes Forge AI-native

Legacy kernels cannot retrofit these properties:

| # | Property | What it gives the agent |
|---|---|---|
| 1 | **Native provenance and naming** on every entity | Stable references across edits, which fixes topological naming at the root. Provenance is also the reference language an LLM uses ([ADR 0006](adr/0006-native-persistent-naming.md)). |
| 2 | **Explainable operations** | Every failure returns a structured cause and the feasible parameter range, computed analytically where possible, e.g. `max feasible r = 3.41`. |
| 3 | **Bit-identical determinism** on macOS, Windows, Linux and WASM | Reproducible evals, caching and trajectory replay. No nondeterministic parallelism affects results. |
| 4 | **Exact-first numerics** for analytic geometry (most maker and CNC parts) | Certified, tolerance-aware handling elsewhere. Tolerances are explicit per entity and never creep silently. |
| 5 | **Query-native** | Semantic selectors (`plate.cap("end")`, `.edges().parallel(Z)`) are evaluated inside the kernel. |
| 6 | **Differentiable evaluation** (F4) | Gradients of volume, mass, distances and clearances with respect to parameters. They enable "make it 20% lighter" requests, optimization and exact RL rewards. |
| 7 | **Convergent representations** | B-rep, SubD, mesh and SDF live in one kernel ([ADR 0011](adr/0011-native-freeform.md)). |
| 8 | **Performance by design** | Data-oriented storage, SIMD, rayon parallelism outside the deterministic path, and GPU compute later |

---

## Topology model

### Storage

- **Structure.** A half-edge B-rep stored in arenas and addressed by **typed generational IDs** (`BodyId`, `ShellId`, `FaceId`, `LoopId`, `HalfEdgeId`, `EdgeId`, `VertexId`). There are no `Rc<RefCell<…>>` pointer graphs.
- **Generational IDs.** A stale ID is detected instead of aliasing a reused slot.
- **IDs stay in-process.** They never leave the process and are never persisted. Anything stored in a file or shown to an agent uses provenance names or semantic queries.

### Periodic surfaces: no seam edges

Decision record: [ADR 0012](adr/0012-no-seam-edges.md).

- **Periodic parameter domains.** Cylinders, cones, spheres, tori and periodic B-splines are handled natively in the **face parameter domain**, which is periodic in u and/or v, as in Parasolid. A full cylindrical face therefore has no seam edge; its boundary is two loops.
- **Ring edges are allowed.** A ring edge is a closed edge with no vertices, such as the circle bounding a cylinder's end. A loop may consist of a single ring half-edge.
- **Loopless faces are allowed.** Examples are a full sphere and a full torus.
- **Singularities.** Cone apexes and sphere poles are **surface singularities**, not degenerate edges or special vertices. No zero-length edges exist, which is consistent with the IR rule that a length ≤ `LINEAR_TOLERANCE` is degenerate.
- **Euler check.** Invariant checkers use a generalized Euler–Poincaré check that accounts for ring edges, loopless faces and periodic face domains. The exact formula is specified alongside the checker in `forge-check`.
- **Oracle diffs.** OCCT's seam and degenerated edges are excluded from edge counts ([SPEC §5](../forge/crates/forge-ir/SPEC.md#5-metrics-aicadmetrics0)). Vertex counts are not compared in v0.

### Provenance

Every face, edge and vertex carries provenance:

| Field | Meaning | Example |
|---|---|---|
| `feature` | The IR feature that created the entity (by name) | `plate` |
| `role` | What the entity is within that feature's result | `side`; `cap`, qualified `start` or `end` |
| `source` | The input entities it came from: sketch curve IDs, or input faces and edges for booleans and blends | `bottom` (a sketch line id) |
| `index` | Disambiguates several entities from the same (feature, role, source), e.g. pieces of a split face, in a canonical order | `0`, `1` |

- **Canonical names.** Provenance serializes to a canonical name. Two examples:
  - `plate/side:bottom` is the side face that extrude `plate` swept from sketch curve `bottom` (see `corpus/programs/extrude_box.json`).
  - `plate/cap:end` is its end cap.

  These examples are illustrative. The full name grammar, covering edges, vertices and indices, is specified in `forge-core`.
- **Completeness is an invariant.** Every operation must assign provenance to every entity it creates. The invariant checker rejects a result with unnamed entities.
- **Queries and tags sit on top.** Semantic queries and explicit tags resolve against provenance. The fingerprint fallback always warns and lists ranked candidates ([ADR 0006](adr/0006-native-persistent-naming.md)).

---

## Numerics policy

| Rule | Detail |
|---|---|
| **Generic `Scalar` trait** | <ul><li>Numeric code is written once, generic over `Scalar`.</li><li>**f64** now, for speed.</li><li>**Interval**, for certification.</li><li>**Dual**, for exact gradients, which builds differentiability in.</li><li>**Rational**, as the in-house exact oracle for analytic cases.</li></ul> Don't hardcode `f64` in algorithms we will want to certify or differentiate. |
| **Adaptive exact predicates** for combinatorial decisions | <ul><li>Orientation, incircle-style tests, point classification and ordering decisions use `forge_core::predicates` (Shewchuk-style adaptive exact).</li><li>Raw floats are never compared against a magic epsilon inside topology decisions.</li></ul> |
| **Explicit, named tolerances** | <ul><li>Every tolerance is a named, documented constant or a field of a `Tolerance` struct.</li><li>IR v0 defines `LINEAR_TOLERANCE = 1e-6` mm: points closer than this are coincident, and a length at or below it is degenerate.</li><li>An explicit frame's `normal` and `x_dir` must be perpendicular within \|cos\| ≤ 1e-9.</li><li>Per-entity tolerances are explicit and never grow silently.</li><li>`kernel-diff` comparison tolerances are for comparison only, never for modeling ([SPEC §6](../forge/crates/forge-ir/SPEC.md#6-diff-rules-kernel-diff)).</li></ul> |
| **Portable transcendentals** | <ul><li>`sin`, `cos`, `atan2`, `exp`, `ln` and other transcendentals go through `forge_core::math` wrappers, backed by a portable libm.</li><li>Nothing calls platform intrinsics directly.</li><li>No fast-math.</li></ul> |
| **Bit-identical results** on macOS, Windows, Linux and wasm32 | <ul><li>The same input produces the same output bits on every target, and CI checks this across targets.</li><li>No `HashMap`/`HashSet` iteration order may reach an output: use `BTreeMap`, `IndexMap` or a sorted `Vec`.</li><li>Outputs use canonical orders, e.g. regions sorted by `outer_curves`.</li><li>A NaN reaching an output is a bug and is reported as an error, since NaN payload bits are not portable.</li></ul> |
| **Schedule-independent parallelism** | <ul><li>rayon is used only where the result cannot depend on scheduling, e.g. independent per-face work merged in canonical order.</li><li>Floating-point reductions run in a fixed order, never through work-stealing `reduce`.</li></ul> |
| **Exact metrics** | Volume, area, centroid and bbox are computed on the exact geometry, never on a tessellation ([SPEC §5](../forge/crates/forge-ir/SPEC.md#5-metrics-aicadmetrics0)). |

---

## Verification machine

The verification machine is built **before** the features. It is our answer to the long tail of edge cases that sank Fornjot and slowed Zoo ([RESEARCH.md](RESEARCH.md#1-geometry-kernels)).

### Differential testing against OCCT

- **The harness.** `oracle/` (Python OCP/build123d) evaluates the same IR. `kernel-diff` then compares the two `aicad.metrics/0` reports.
- **Exact matches required:**
  - status and error codes;
  - region, body, face and edge counts;
  - face and edge type histograms;
  - validity.
- **Tolerance matches:** volume, area, centroid and bbox, using the tolerances in [SPEC §6](../forge/crates/forge-ir/SPEC.md#6-diff-rules-kernel-diff). Hausdorff distance is added for general geometry.
- **Classifying mismatches:**
  - One engine errors and the other doesn't → **robustness difference**.
  - Both report `ok` but a metric differs → **potential silent-wrong**. The oracle is not presumed correct, so every such case is investigated.
- **Corpora:**
  - our corpus (`corpus/programs`);
  - about 178k DeepCAD sketch-and-extrude programs;
  - Fusion 360 Gallery reconstruction sequences;
  - ABC STEP models (1M) for import, tessellation and mass-property checks.

  Every dataset licence is checked and recorded in `corpus/external/SOURCES.md` before use.

### Other layers

| Layer | What it does |
|---|---|
| Property and fuzz testing | proptest and cargo-fuzz: random feature programs, random perturbations, and near-degenerate generators (tangent, coincident and sliver cases) |
| Invariants after every operation (debug and test builds) | Generalized Euler characteristic, closed shells, orientation, no self-intersection, provenance completeness |
| Formal verification | Kani/Verus proofs for predicates and topology invariants; Miri runs on the test suite |
| Cross-target check | Bit-identical outputs on macOS, Windows, Linux and wasm32 |
| Failure zoo | Every bug becomes a permanent regression case |

### Failure policy

- Forge **fails loudly** with a structured diagnostic. It never silently returns wrong geometry.
- A release gate requires **0 silent-wrong results**, as measured by the oracle.
- A failed feature passes its input through, so one regeneration reports every error.

---

## Milestones

Every milestone is gated by oracle comparison and the robustness corpus. Work is ordered from winnable cases outward: analytic → B-spline → general NURBS.

| # | When | Scope | Gate |
|---|---|---|---|
| **F0** | M1–M2 | Topology and provenance, analytic and B-spline curves, analytic surfaces, exact predicates, planar regions, extrude and revolve (spline profiles included), tessellation, mass properties, STL/3MF export, the oracle harness | Bit-identical on all four targets; matches the oracle on 1k extrude/revolve programs |
| **F1** | M2–M5 | SSI (surface–surface intersection) for analytic pairs plus certified marching, booleans, holes, patterns, mirror, STEP export, STEP import (analytic + B-spline) | ≥99.5% agreement with the oracle on DeepCAD replays; fewer failures than OCCT; 0 silent-wrong results |
| **F2** | M4–M8 | Fillet and chamfer, shell and offset, draft, healing, text emboss | **Maker release gate.** Validity ≥ OCCT on the 300-case fillet/chamfer/shell corpus and the maker corpus; provenance survival ≥99% |
| **F3** | M8–M14 | Full NURBS surfacing: sweep, loft, general and variable blends, NURBS offsets, HLR for drawings, sheet-metal operations | To be set before F3 starts |
| **F4** | M12–M18 | Differentiable evaluation; native SubD, mesh and SDF (convergent modeling) | To be set before F4 starts. Phase 5 exit: SubD → B-rep ≥90% success on cages up to 2k faces. |
| **F5** | M18+ | GPU compute (tessellation, analysis, batch evaluation for agents); `forge-sim`, a differentiable FEA validated against CalculiX; CAM toolpaths | To be set before F5 starts. Phase 5 exit: FEA within ±10% of the oracle on 15 cases. |

M1 = Oct 2026. How these milestones map onto product phases is in [ROADMAP.md](ROADMAP.md).

---

## Design rules

These are the Forge conventions from [CLAUDE.md](../CLAUDE.md). They are binding on every contributor, human or agent.

### Ownership and licensing

- **No runtime dependency** on another CAD kernel, constraint solver, mesher or renderer.
  - OCCT, PlaneGCS, SolveSpace, OpenSubdiv, Manifold and CalculiX may appear **only** in `oracle/` or CI test tooling.
  - Small generic crates (serde, thiserror, smallvec, proptest, …) are fine.
- **No runtime LGPL/GPL.** Check the licence of every new dependency. CI runs `cargo deny`.

### Topology and data

- Topology lives in arenas with typed generational IDs (`FaceId`, `EdgeId`, …). No `Rc<RefCell<…>>` pointer graphs.
- IDs never leave the process. Anything persisted uses provenance or semantic names.

### Numerics and determinism

- Numeric code is generic over `Scalar` wherever that's practical.
- No iteration over `HashMap`/`HashSet` where the order can reach an output.
- No fast-math. Transcendentals go through `forge_core::math`.
- rayon only where the result doesn't depend on scheduling.
- Orientation and incircle-style decisions use `forge_core::predicates`. Tolerances are explicit, named and documented (`Tolerance` struct).

### Errors

- Use `thiserror` enums carrying a machine-readable `code` plus structured context (entity IDs, feasible ranges).
- These errors feed the agent's repair hints, so they must be precise.
- Every kernel operation returns either a valid result or a structured, explainable error.

### Safety

- `unsafe` is forbidden at the workspace level (`unsafe_code = "forbid"`). It is not allowed without an ADR.

### Tests and verification

- **Every new operation arrives in one PR with:**
  - unit tests;
  - property tests (`proptest`);
  - invariant checks;
  - an oracle comparison case.
- **Invariant checkers** (`forge-check::validate`) run after every op in debug and test builds.
- **Test names** describe the behavior they check.
- **Before merging:** `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` are clean.
- **Geometry changes** need an oracle diff on `corpus/programs`. Differences are explained or fixed, never ignored.
- **Changed decisions or contracts** require updating the relevant doc or ADR.

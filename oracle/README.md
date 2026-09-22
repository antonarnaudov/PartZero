# aicad oracle: OCCT reference evaluator for IR v0

The oracle evaluates the same `aicad.ir/0` documents as Forge, using OCCT through
build123d/OCP. It emits the same `aicad.metrics/0` report, so the two engines can be diffed
under the rules in `forge/crates/forge-ir/SPEC.md` §6.

- It is **dev/CI tooling only and is never shipped**. OCCT is LGPL. See `CLAUDE.md`, "Own the core; borrow only as oracles".
- The semantics it implements are the ones in `SPEC.md`, and nothing else.
- Where the spec was silent, the choice the oracle made is listed under [Spec gaps](#spec-gaps-and-the-choices-the-oracle-made). Fix those in the spec, not here.

## Setup

```bash
cd oracle
uv sync                 # creates .venv with the pinned CPython and wheels
uv run pytest           # 142 tests, about 8 s
```

**Python is pinned to 3.13** (`.python-version`).
- `cadquery-ocp-novtk 7.9.3.1.1` (OCCT 7.9.3) ships cp310–cp314 wheels for macOS arm64/x86_64, manylinux_2_31 x86_64/aarch64 and Windows.
- 3.13 is the newest CPython that every transitive dependency also covers.
- Verified: `uv sync` on macOS arm64, plus `uv pip install --dry-run --only-binary :all: --python-platform x86_64-manylinux_2_31` for Linux x86_64.

**`build123d==0.12.0`** is pinned. It is the latest release on OCCT 7.9.
- 0.13.0 (2026-09-21) moved to OCCT 8.0.1. We don't adopt a brand-new major OCCT for the reference engine without a separate evaluation.
- The oracle calls OCP directly for everything geometric.
- build123d is used for its version string and for the `--step` debug export.

The JSON Schemas and `ir-v0.constants.json` are **read at run time** from `forge/crates/forge-ir/schema/`. They are never vendored. Override the location with `AICAD_IR_SCHEMA_DIR`.

## Commands

| Command | What it does | Exit code |
|---|---|---|
| `oracle eval FILE [--out R.json] [--self-check] [--step OUT.step]` | Validates FILE (JSON Schema + the `validate.rs` rules), evaluates it, validates the report against `metrics-v0.schema.json`, and prints or writes the report. | 0 = `ok`, 1 = `status: error`, 2 = usage, 3 = internal schema violation, 4 = self-check failure |
| `oracle diff DIR\|FILE [--forge-bin BIN] [--golden-dir D] [--report out.md] [--fail-on-robustness]` | For each program, runs the oracle and `BIN eval FILE --format json`, then compares them per §6. Prints a table and optionally writes a Markdown report. | 1 on any `POTENTIAL_SILENT_WRONG` |
| `oracle diff --a R1.json --b R2.json [--report out.md]` | Compares two reports directly. | same as above |
| `oracle golden DIR [--out D]` | Writes `<D>/<stem>.metrics.json` for every program in DIR. D defaults to `DIR/../golden`. These files **are committed**. | 4 if a self-check fails |
| `oracle gen [--count 1000] [--seed 0] [--out ../corpus/generated/] [--jobs N] [--with-reports]` | Generates random valid F0 programs. See [Generator](#generator). | 1 if a program could not be produced |

`oracle diff` details:
- If `--forge-bin` is missing or doesn't exist, it prints a warning and compares the oracle against `corpus/golden/*.metrics.json`. This happens in CI until `aicad` exists, and it doubles as an OCCT-drift check.
- A Forge run that produces no parseable report counts as `ROBUSTNESS`, not as a pass.
- Programs with no reference are listed as `NO_REFERENCE`.

Classification:
- **ROBUSTNESS**: one engine errors (or crashes) and the other doesn't. Both erroring with different codes is also put here.
- **POTENTIAL_SILENT_WRONG**: both report `ok` for a feature, but a §6 field differs.
- **MATCH**: no difference.
- The worst class over a document's features wins.

The comparison logic is `compare.py`: pure functions, unit-tested in `tests/test_compare.py`.

## How it evaluates (module map)

| Module | Role |
|---|---|
| `ir.py` | Typed model and plane resolution (§2, same arithmetic as `PlaneSpec::resolve`). Also a line-by-line port of `validate.rs`: the same codes in the same order, with document-wide id/name uniqueness and `RESERVED_NAME` from the constants file. |
| `sketch.py` | **Pure 2D, no OCCT.** Endpoint matching, loop walking, analytic crossing and touch detection, winding-number nesting, regions, canonical order, and closed-form areas and first moments. |
| `occt.py` | Region → planar face → prism/revol solid → metrics. Every OCCT convention is normalised here; see the next section. |
| `evaluate.py` | §4 timeline: suppression, `SKETCH_SUPPRESSED`, error continuation, report assembly. |
| `selfcheck.py` | Independent closed-form predictions for every body; see [Self-checks](#self-checks). |
| `compare.py`, `diffrun.py` | §6 diff and the runner. |
| `generator.py` | Random program generator. |

**Sketch topology is decided by the oracle's own 2D code, not by OCCT.** OCCT only receives regions that are already valid.

The crossing test is analytic:
- **Pairs checked:** line–line, line–circle and circle–circle intersections.
- **Tangency:** treated as one contact when |d − r| ≤ 1e-6.
- **Near misses:** endpoint-to-curve distances ≤ 1e-6 count as contacts.
- **Overlaps:** a shared stretch longer than 1e-6 (collinear lines, or arcs on the same circle) is a crossing.
- **Shared endpoints:** contacts within 2·1e-6 of an endpoint shared by the two curves are ignored. This is what makes tangent slot joins and "a circle made of arcs" legal.

## OCCT conventions the oracle normalises

1. **Planes are explicit.**
   - Every sketch builds `gp_Ax3(origin, normal, x)` from SPEC §2, so the XZ normal is −Y and the YZ x-axis is +Y.
   - build123d's named planes are never used.
   - Arcs are `Geom_Circle(gp_Ax2(c, n, x), r)`, parametrised counter-clockwise about the sketch normal. `ccw=false` arcs are built counter-clockwise from end to start and then reversed.
2. **Shared vertices.** Each loop junction is a single `TopoDS_Vertex` at the midpoint of the two partnered endpoints. Its tolerance is `max(1e-7, 1.5 × the actual gap)`, so sub-tolerance gaps never break `MakeWire`.
3. **Orientation.** Outer loops are wired counter-clockwise about the normal and holes clockwise. Every face's OCCT area is checked against the region's closed-form area to 1e-9 (`ORACLE_INTERNAL` otherwise). A solid with negative volume would be re-oriented with `BRepLib::OrientClosedSolid`; this never happened.
4. **Sweep directions.**
   - Extrude `reverse`: prism along −n.
   - Extrude `symmetric`: translate by −d/2·n, then prism by d·n.
   - Revolve `reverse`: revolve about the reversed axis.
   - Revolve `symmetric`: pre-rotate by −angle/2.
   - Right-hand rule: tested, since +90° about +Z carries +X to +Y.
5. **Seam edges are not counted.** An edge is a seam if `BRep_Tool::IsClosed(edge, face)` holds for any adjacent face. Examples:
   - the cylinder seam line;
   - the profile curve of a 360° revolve;
   - both seams of a full torus;
   - the vertex arc of a partial torus.
6. **Degenerated edges are not counted** (`BRep_Tool::Degenerated`). Examples: cone apexes, sphere poles, and profile vertices on the axis.
7. **Canonical types.**
   - Faces use `BRepAdaptor_Surface::GetType`.
   - Surfaces of revolution are classified from the basis curve and the axis: a line parallel to the axis is a cylinder, a perpendicular line a plane, a coplanar line a cone, an otherwise skew line `other`; a circle centred on the axis is a sphere, any other in-plane circle a torus.
   - Surfaces of extrusion: line → plane, circle → cylinder.
   - B-spline, Bézier and offset surfaces go through `ShapeAnalysis_CanonicalRecognition` (plane, cylinder, cone, sphere); anything else stays `bspline`.
   - Edges are handled the same way: line, circle, ellipse (an ellipse with equal radii counts as a circle), then bspline or other.
   - In practice `BRepSweep_Rotation` already produces analytic surfaces for every v0 profile, including profiles rotated by arbitrary angles in the sketch.
8. **The bounding box is tight.**
   - `BRepBndLib::AddOptimal(useTriangulation=false, useShapeTolerance=false)` still enlarges analytic tori by `Precision::Confusion()`. The corpus torus came out as ±19.0000001.
   - The oracle therefore builds the box from exact pieces: every non-degenerated edge (exact for lines and circles), every vertex, and the analytic interior critical points of sphere and torus faces, kept only if `BRepClass_FaceClassifier` puts them inside the face.
   - Planes, cylinders and cones reach their extremes on edges.
   - Tests check it against dense surface sampling and against `AddOptimal` (the oracle's box must lie inside it and within 1e-6).
9. **Mass properties use the non-adaptive integrator.** They are computed on the exact surfaces (`UseTriangulation=false`), but *not* with the adaptive `Eps` overloads. Against closed-form prism and Pappus values on 526 generated bodies:
   - **adaptive `VolumeProperties(S, P, Eps)`:** has a false-convergence error estimator. With `Eps=1e-9`, a circular-segment revolve was off by **1.2e-5 relative**, above the §6 tolerance, while reporting an estimated error of 2e-16. With `Eps=1e-12` it was still 1.7e-9 off.
   - **`VolumePropertiesGK`:** accurate, but took 18–150 s on some bodies.
   - **Default fixed-order Gauss:** worst 3.2e-11 (volume) and 6.5e-13 (area), at about 0.1 ms per body. **This is what the oracle uses.**
10. **Validity** is `BRepCheck_Analyzer::IsValid()`. It checks closure and orientation, but not self-intersection; see the limitations.
    - An OCCT solid that BRepCheck rejects is reported as a **feature error `OCCT_INVALID_RESULT`**, not as `ok` with `valid: false` and meaningless metrics. A disagreement with Forge then classifies as ROBUSTNESS, which blames the right engine, instead of a false POTENTIAL_SILENT_WRONG.
    - So oracle reports never contain `valid: false`.

## Self-checks

For every body, `selfcheck.py` predicts the following from the 2D profile alone, and `oracle eval --self-check`, `oracle golden`, `oracle gen` and the tests compare the prediction with OCCT:

| Quantity | Prediction | Tolerance |
|---|---|---|
| Volume | extrude A·d; revolve θ·\|∬ρ dA\| (Pappus) | 1e-9 relative |
| Area | extrude 2A + P·d; revolve θ·Σ\|∫ρ ds\| + 2A for partial revolves | 1e-9 relative |
| Centroid | extrudes only | 1e-9·s |
| `faces`, `edges`, `face_types`, `edge_types` | the §4/§5 counting rules | exact |
| bbox | against `AddOptimal` | see item 8 above |

The counting rules used for the topology prediction:
- one face per profile curve not on the axis, plus 2 caps when the angle is below 360°;
- partial revolve: 2 edges per non-axis profile curve, 1 per axis curve, 1 arc per off-axis vertex;
- full revolve: only the off-axis vertex circles;
- extrude: 3 edges per curve of a polygonal loop, 2 per circle.

A disagreement means the oracle, OCCT, or a normalisation above does not follow the spec. `gen` rejects the program and reports it.

## Generator

`oracle gen` writes these files:
- `gen_s<seed>_<index>.json` programs;
- `gen_s<seed>.stats.json`, which counts failures by kind and code;
- `rejected/` with every program the oracle failed on, for triage.

How programs are produced:
- **Seeding.** Each program uses its own RNG, seeded with `aicad-gen/<seed>/<index>/<attempt>`, so output is byte-identical across `--jobs` values.
- **Validity checks.** Every program is checked against the IR JSON Schema and the `validate.rs` rules. It is then evaluated with all self-checks, and must end with `status: ok`.
- **Identity rules.** Feature ids and names are unique across the whole document, and never in `RESERVED_NAMES`.
- **Extrude content:**
  - shapes: rectangles, convex and star (concave) polygons, slots, circles, rounded rectangles, arc+chord "D" shapes (two-curve loops), two-arc lenses, and circles cut by chords or arcs of the same circle;
  - 1–3 disjoint regions;
  - holes placed inside the inscribed circle, and islands inside holes (depth 2);
  - planes: XY, XZ, YZ, or random frames (sometimes with non-unit vectors);
  - all three sweep directions.
- **Revolve content:**
  - profiles built in (ρ, z) with ρ ≥ 0, then mapped rigidly (sometimes mirrored) onto a random axis;
  - off-axis rings, rectangles touching the axis along an edge (cylinders), cones and frustums, apex-only touches, trapezoids, tori, **horn tori** (a circle tangent to the axis), balls and hemispheres (arcs centred on the axis), spherical shell sectors, D-shaped torus patches, and any extrude shape placed off-axis;
  - profiles with holes, and two stacked regions;
  - angles: 360°, the classic set, random, tiny (0.01°–1°) and almost-closed (359°+).
- **Variety and stress:** random curve order, per-curve direction flips and shuffled ids (`c10` < `c2`); suppressed features; second part studios; global scale ×0.01…×100; frame origins 1e3–1e4 away; concentric thin walls (gap 1e-5–1e-3 of size).

Verified runs with the final code (7,200 programs, ~11,000 bodies):

| Seed | Programs | Oracle failures |
|---|---|---|
| 1 | 200 | 0 |
| 0 (default) | 1000 | 0 |
| 11 | 2000 | 0 |
| 42 | 2000 | 0 |
| 3 | 2000 | **1** |

The one failure is a genuine OCCT defect, `OCCT_INVALID_RESULT`:
- **What:** a 120° revolve of a circle of radius 0.024 tangent to the axis, on a tilted frame. It comes from the ×0.01 stress scale applied to a horn torus.
- **Result:** OCCT 7.9.3 returns a solid that BRepCheck rejects, with volume 3.5e-20.
- **Where it holds:** 360° of the same profile is fine. The same program fails at ×10 and ×100 but not at ×1000.
- **How rare:** a targeted sweep of 400 axis-tangent circles failed once (1 of 143 partial revolves with r < 1).
- **Reproducer:** pinned in `tests/test_eval.py::test_oracle_never_reports_an_occt_invalid_body_as_ok`.

During development two more failure classes appeared. Both were bugs on our side and both are fixed:
- the generator scaled holes without scaling circle radii;
- OCCT's adaptive integrator (item 9 above) failed the Pappus self-check on 3 of 2000 programs.

## Known limitations

- **Validity is BRepCheck, not a full self-intersection check.** `BOPAlgo_ArgumentAnalyzer` is not run. The horn torus touches itself at a point on the axis, which the spec explicitly allows; OCCT reports it valid.
- **Exact-geometry numbers still carry a small float budget:** volume ≤ 3e-11, area ≤ 1e-12, centroid ~1e-13·s, relative to closed forms. That is far inside the §6 tolerances, but the golden files are not bit-reproducible across platforms or OCCT versions. Diff with tolerances, never byte-compare.
- **The 2D crossing test compares points and distances in doubles**, with no exact predicates. Configurations that sit exactly at the 1e-6 contact threshold can flip.
- **No `SKETCH_DEGENERATE_LOOP` / `SKETCH_NO_REGIONS` in practice.** A zero-area loop always contains an overlap, so `SKETCH_CURVES_CROSS` fires first. A structurally valid sketch always has a depth-0 loop, so `SKETCH_NO_REGIONS` is unreachable. Both codes are implemented but untested.
- **v0 only:** lines, arcs and circles; extrude and revolve; new bodies. Free-form recognition paths exist but are not exercised.

## Spec gaps and the choices the oracle made

Each of these must be pinned down in `SPEC.md`, because §6 compares codes and counts exactly.

1. **A feature that consumes a failed sketch** gets no code from the spec. The oracle re-reports the sketch's own code (e.g. `SKETCH_OPEN_LOOP`) on the extrude/revolve.
2. **Error precedence inside one sketch** is unspecified.
   - The oracle applies rule 1 (endpoints), then 3 (crossings), then 4 (degenerate loops), then no-regions.
   - Endpoints are scanned in curve order, start before end. The first endpoint with 0 partners gives `OPEN_LOOP`; with more than 1, `BRANCHING`.
   - Crossings are scanned over pairs (i < j) in curve order.
3. **The coincidence boundary is inconsistent.** §1 says "closer than 1e-6", which is strict (`<`); `validate.rs` treats lengths `<= 1e-6` as degenerate. The oracle uses `<` for coincidence.
4. **"Touch" and "at shared endpoints" have no tolerance semantics.** The oracle's rule:
   - a contact is a distance ≤ 1e-6;
   - contacts within 2e-6 of an endpoint shared by that pair are ignored;
   - any overlap longer than 1e-6 is a crossing.
5. **`SKETCH_DEGENERATE_LOOP` has no area threshold.** The oracle uses |A| ≤ 1e-12 mm². The code is effectively dead given rule 3.
6. **Arc end off the circle.** `|end − center|` may differ from r by up to 1e-6, and the spec doesn't say which end point is geometric. The oracle uses the angle of `end` on the radius-r circle, and places the vertex at the midpoint of the partnered endpoints.
7. **`REVOLVE_CROSSES_AXIS`:**
   - Is "strictly" with tolerance? The oracle requires signed distance > 1e-6 on both sides.
   - May *different* regions sit on opposite sides of the axis? The oracle allows it; each region is checked separately.
   - If one region crosses, does the whole feature fail? The oracle fails it with no bodies.
8. **Canonical-type decision tolerances are missing.** The spec gives none for "line parallel or perpendicular to the axis" (cylinder/plane vs cone) or for "arc centred on the axis" (sphere vs torus). It also doesn't say that a spindle torus (arc centre off-axis by less than the radius) is still `torus`. The self-check uses |sin|, |cos| ≤ 1e-9 and 1e-6; OCCT uses its own internal tolerances.
9. **Topology rules that are only implied should be stated.** The counts above assume these, and OCCT agrees on every generated program:
   - every sketch curve is its own face, even across tangent joins and for arcs of the same circle;
   - an axis-lying profile edge is **one edge** shared by both end caps when angle < 360, and no edge at 360;
   - profile vertices on the axis produce no edge.
10. **Document-level failures have no defined codes.** The spec defines neither the top-level `error` codes for unparseable or schema-invalid documents nor whether §6 compares them. The oracle emits `IR_PARSE_ERROR`, `IR_SCHEMA_INVALID`, or the first `validate.rs` code, with `features: []`. The diff reports a code difference only as a note.
11. **§6 arithmetic is under-specified:**
    - relative to which value? The oracle uses max(|a|, |b|);
    - s from which engine's body? The oracle uses the larger diagonal;
    - region area has "s from the body's bbox", but regions have no body; the oracle uses s = 1;
    - centroid and bbox tolerances: per coordinate or Euclidean? The oracle uses per coordinate;
    - both engines erroring with *different* codes, or differing feature lists, fall in neither class. The oracle calls them ROBUSTNESS, or SILENT_WRONG when both documents are `ok`.
12. **An engine's own invalid result has no defined report.** The spec doesn't say whether it is `ok` with `valid: false` or a feature error. The oracle chooses the error (`OCCT_INVALID_RESULT`, see item 10 of the conventions).
13. **`valid` must match exactly, but each engine uses its own validity check.** BRepCheck does not check self-intersection, while §5 says `valid` means "no self-intersections". The two engines will not agree on borderline bodies, such as the horn torus.
14. **The frame is not re-orthogonalised.** `x_dir` is not orthogonalised against `normal`; y = n × x with |cos| ≤ 1e-9. OCCT's `gp_Ax3` does orthogonalise it. The effect is ≤ 1e-9·size, harmless, but worth one sentence in the spec.
15. **Reserved names cover features only.** `RESERVED_NAMES` applies to feature names, but part names have no syntax rules at all. The corpus uses the part name `part`, which is reserved for features. Say whether part names are CadScript identifiers too.

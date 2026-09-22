# aicad oracle: OCCT reference evaluator for IR v0

The oracle evaluates the same `aicad.ir/0` documents as Forge, using OCCT through
build123d/OCP. It emits the same `aicad.metrics/0` report, so the two engines can be diffed
under the rules in `forge/crates/forge-ir/SPEC.md` §6.

- It is **dev/CI tooling only and is never shipped**. OCCT is LGPL. See `CLAUDE.md`, "Own the core; borrow only as oracles".
- It implements SPEC revision **2026-09-23b** (rules tagged [R-1]…[R-15]), and nothing else.
- Where the spec still leaves room, the oracle's reading is listed under [Open spec points](#open-spec-points). Fix those in the spec, not here.

## Setup

```bash
cd oracle
uv sync                 # creates .venv with the pinned CPython and wheels
uv run pytest           # 161 tests, about 13 s
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
| `oracle eval FILE [--out R.json] [--self-check] [--step OUT.step]` | Validates FILE (JSON Schema + the `validate.rs` rules), evaluates it, validates the report against `metrics-v0.schema.json`, and prints or writes the report. `--self-check` also prints the gate's findings. | 0 = ok, 1 = a feature failed, **2 = document rejected [R-10]** or usage error, 3 = internal schema violation, 4 = gate findings (only with `--self-check`) |
| `oracle diff DIR\|FILE [--forge-bin BIN] [--golden-dir D] [--report out.md] [--fail-on-robustness]` | For each program, runs the oracle and `BIN eval FILE --format json`, then classifies per §6. Prints a table and optionally writes a Markdown report. | 1 on any `POTENTIAL_SILENT_WRONG` or `CODE_MISMATCH` (also on `ROBUSTNESS` with the flag) |
| `oracle diff --a A.json --b B.json [--report out.md]` | Compares two reports directly (A = Forge, B = oracle). | same as above |
| `oracle golden DIR [--out D]` | Writes `<D>/<stem>.metrics.json` for every program in DIR. D defaults to `DIR/../golden`. These files **are committed**. | 4 if a gate fails |
| `oracle gen [--count 1000] [--seed 0] [--out ../corpus/generated/] [--jobs N] [--with-reports] [--invalid-per-kind 4] [--invalid-out D]` | Generates random valid F0 programs **and** an error corpus in `<out>/invalid/`. See [Generator](#generator). | 1 if a program could not be produced, or the oracle disagrees with an error-corpus expectation |

`oracle diff` details:
- **Rejection [R-10].** Forge exiting with code 2 means the document was rejected. Both engines rejecting is `MATCH`; only one rejecting is `ROBUSTNESS`.
- **Missing Forge binary.** If `--forge-bin` is missing or doesn't exist, it warns and compares the oracle against `corpus/golden/*.metrics.json`. This happens in CI until `aicad` exists, and it doubles as an OCCT-drift check.
- **Crash.** A Forge run that produces no report and doesn't exit 2 counts as `ROBUSTNESS`.

Classification (§6, [R-11]) is the most severe class found in a program, in the order POTENTIAL_SILENT_WRONG > CODE_MISMATCH > ROBUSTNESS > MATCH. The spec does not rank them; this order is the oracle's choice.

| Class | When |
|---|---|
| `MATCH` | Every rule holds, or both engines rejected the document. |
| `ROBUSTNESS` | Only one engine errored or rejected; or either engine reported an engine-prefixed internal code (`OCCT_*`, `FORGE_*`). |
| `CODE_MISMATCH` | Both engines failed the same feature with different **semantic** codes. |
| `POTENTIAL_SILENT_WRONG` | Both engines reported `ok`, but an exact field or a tolerance field differs. |

§6 arithmetic, implemented exactly in `compare.py`:
- `rel = |a−b| / max(|a|, |b|)`;
- `s = max(1, diagA, diagB)`, with `s = 1` for regions;
- vectors are compared per component;
- `valid` is **not** compared [R-13].

## How it evaluates (module map)

| Module | Role |
|---|---|
| `ir.py` | Typed model; plane resolution with x re-orthogonalised against the normal ([R-14], same arithmetic as `PlaneSpec::resolve`); a line-by-line port of `validate.rs`, with document-wide id/name uniqueness and `RESERVED_NAME` from the constants file. |
| `sketch.py` | **Pure 2D, no OCCT.** Staged sketch errors [R-2]: endpoints, crossings, degenerate loops. Also loop walking, winding-number nesting, regions, canonical order, closed-form areas and moments, and snapping to the axis. |
| `occt.py` | Region → planar face → prism/revol solid → metrics. Every OCCT convention is normalised here; see the next section. |
| `evaluate.py` | §4 timeline: suppression, `SKETCH_SUPPRESSED`, `DEPENDENCY_FAILED` [R-1], error continuation, the body gate, report assembly. |
| `selfcheck.py` | The gate: independent closed-form and §4.4 predictions for every body. |
| `compare.py`, `diffrun.py` | §6 diff and the runner. |
| `generator.py`, `invalidgen.py` | Valid-program generator and error-corpus generator. |

Tolerance comparisons are **inclusive** [R-3]:
- points coincide when `d ≤ 1e-6`;
- lengths are degenerate when `≤ 1e-6`;
- loops are degenerate when `|A| ≤ 1e-12` [R-5].

The crossing test [R-4] is analytic. It examines the pair's **contact points** and fails if one lies more than 2·tol from every endpoint the pair shares:
- **Proper intersections:** line–line, line–circle and circle–circle.
- **Tangency points:** where the gap is ≤ tol, located at the foot point or on the centre line.
- **Endpoint contacts:** curve end points within tol of the other curve.
- **Overlaps:** a shared stretch longer than tol always fails.

## OCCT conventions the oracle normalises

1. **Planes are explicit.**
   - Every sketch builds `gp_Ax3(origin, n, x)` from SPEC §2, so the XZ normal is −Y and the YZ x-axis is +Y.
   - build123d's named planes are never used.
   - Arcs are `Geom_Circle(gp_Ax2(c, n, x), r = |start − c|)`, parametrised counter-clockwise about the normal, and end at the angle of `end − c` [R-6].
2. **Shared vertices.**
   - Each loop junction is a single `TopoDS_Vertex` at the midpoint of the two partnered end points.
   - Its tolerance is `max(1e-7, 1.5 × the actual gap)`. Lines run exactly between their given end points [R-6], and the vertex tolerance absorbs any gap of up to tol.
3. **Orientation.**
   - Outer loops are wired counter-clockwise, holes clockwise.
   - Every face's OCCT area is checked against the closed-form region area (`OCCT_INTERNAL` otherwise).
   - Negative-volume solids would be re-oriented. This never occurred in 1200 generated programs.
4. **Sweep directions.**
   - Extrude `reverse`: prism along −n. `symmetric`: translate by −d/2·n, then prism by d·n.
   - Revolve `reverse`: revolve about the reversed axis. `symmetric`: pre-rotate by −angle/2.
   - The right-hand rule is tested.
5. **Profile points within tol of the revolve axis are snapped onto it** before OCCT sees them ([R-3] with §4.4):
   - such a vertex is *on* the axis, so it sweeps to a singular point, never to a ring edge of radius ≤ tol;
   - a profile reaching ≤ tol past the axis does not cross it [R-7];
   - without snapping, OCCT's `BRepPrimAPI_MakeRevol` fails outright on a profile only 5e-7 mm past the axis.
6. **Seams and degenerated edges are never counted** (§4.4, §5).
   - A seam is an edge with `BRep_Tool::IsClosed(edge, face)` on any adjacent face: cylinder seams, the profile curve of a 360° revolve, both torus seams, and the vertex arc of a partial torus.
   - A degenerated edge is one with `BRep_Tool::Degenerated`: cone apexes, sphere poles, and vertices on the axis.
7. **Canonical types, with the §4.4 tolerances [R-8]:**
   - `GetType` first;
   - a cone with |semi-angle| ≤ 1e-9 rad is a `cylinder`, and one within 1e-9 of π/2 is a `plane`;
   - a torus with major radius ≤ tol is a `sphere`; horn and spindle tori stay `torus`;
   - surfaces of revolution and extrusion are classified from the basis curve and the axis;
   - free-form faces go through `ShapeAnalysis_CanonicalRecognition`.
8. **The bounding box is tight.**
   - `BRepBndLib::AddOptimal` enlarges analytic tori by `Precision::Confusion()`, even with shape tolerances off; the corpus torus came out as ±19.0000001.
   - The box is therefore built from exact pieces: non-degenerated edges, vertices, and the analytic interior critical points of sphere and torus faces, kept only if the face classifier puts them inside the face.
9. **Mass properties use the non-adaptive `BRepGProp` integrator**, on the exact surfaces, measured against closed forms on 526 bodies:
   - **Adaptive `VolumeProperties(S, P, Eps)`:** has a false-convergence error estimator. With `Eps=1e-9` it was off by **1.2e-5 relative** while reporting an estimated error of 2e-16.
   - **`VolumePropertiesGK`:** takes 18–150 s on some bodies.
   - **Default fixed-order Gauss:** worst 3.2e-11 (volume) and 6.5e-13 (area). This is what the oracle uses.
10. **Invalid or inexact OCCT bodies are feature errors, never `ok` [R-12].**
    - A body that `BRepCheck_Analyzer` rejects is reported as `OCCT_INVALID_RESULT`.
    - A body that fails the [gate](#the-body-gate) is reported as `OCCT_SELF_CHECK_FAILED`.
    - Both codes are engine-prefixed, so a disagreement with Forge classifies as ROBUSTNESS, not as a false POTENTIAL_SILENT_WRONG.

## The body gate

Every body is gated before it is reported. `selfcheck.py` predicts each quantity from the 2D profile alone, and the body must match:

| Quantity | Prediction | Tolerance |
|---|---|---|
| Volume | extrude A·d; revolve θ·\|∬ρ dA\| (Pappus) | 1e-8 relative |
| Area | extrude 2A + P·d; revolve θ·Σ\|∫ρ ds\| + 2A for partial revolves | 1e-8 relative |
| Centroid | extrudes only | 1e-8·s |
| `faces`, `edges`, `face_types`, `edge_types` | the §4.4 rules | exact |
| bbox | inside and within 1e-6 of `AddOptimal` | — |

The 1e-8 tolerance is 100× inside the §6 tolerance and about 300× above OCCT's measured integration noise.

The gate catches real OCCT defects that would otherwise be silently wrong:
- **Cone snapped to a cylinder.** `BRepSweep_Rotation` builds a cylinder for a profile line up to ~3e-4 rad off parallel, when §4.4 says it is a cone. The geometry is then off by up to 1e-4 mm and the face types are wrong.
- **Partial horn torus returned as a full turn.** OCCT returns a **full 360° torus** for a 311.5° reverse revolve of a circle tangent to the axis. The volume is 15% too high.
- Both are pinned as tests in `tests/test_eval.py`.

## Generator

**Valid programs.** `oracle gen` writes:
- `gen_s<seed>_<index>.json`;
- `gen_s<seed>.stats.json`, which counts oracle failures by kind and code;
- `failed/`, with every program the oracle could not evaluate, for triage. The generator then retries that index.

Every program uses its own RNG, seeded `aicad-gen/<seed>/<index>/<attempt>`, so output is byte-identical across `--jobs` values. Each program is validated (schema + `validate.rs`) and evaluated through the gate. Feature ids and names are unique document-wide and never reserved.

Content:
- **Extrude profiles:** rectangles, convex and star polygons, slots, circles, rounded rectangles, arc+chord "D" shapes, lenses, and circles cut by chords or same-circle arcs.
- **Extrude layout:** 1–3 regions, holes, and islands inside holes. Planes are XY, XZ, YZ or random frames, with every sweep direction.
- **Revolve profiles**, built in (ρ, z) and mapped rigidly onto a random axis:
  - rings and rectangles on the axis, cones and apex touches;
  - tori and horn tori;
  - balls and hemispheres, shell sectors and D-shaped torus patches;
  - off-axis extrude shapes, holes, and stacked regions.
- **Revolve angles:** 360°, classic values, random, tiny (0.01°–1°) and almost-closed.
- **Stress cases:** shuffled curve order, directions and ids; suppressed features; second parts; scale ×0.01…×100; far origins; thin walls.

**Error corpus.** Written to `<out>/invalid/`. `invalidgen.py` produces `inv_s<seed>_<kind>_<k>.json`, 70 per seed. Every case has an expected per-feature outcome under the SPEC, and `gen` checks the oracle against it.

| Kind | Construction | Expected outcome |
|---|---|---|
| `open_loop` | a curve removed, or a line end moved 1.5·tol … 1e-3 | `SKETCH_OPEN_LOOP` |
| `branching` | a duplicated line, or a fin at a vertex | `SKETCH_BRANCHING` |
| `crossing` | a circle dropped on a line | `SKETCH_CURVES_CROSS` |
| `near_touch` | line/circle, internal and external circle/circle, vertex/line and parallel line/line, at gaps {0.3, 0.6, 0.95}·tol | `SKETCH_CURVES_CROSS` |
| | the same pairs at {1.5, 3, 50}·tol (controls) | `ok` |
| `crosses_axis` | δ ∈ {2·tol, 10·tol, 1e-3, 0.5} past the axis, with and without an extra valid region | `REVOLVE_CROSSES_AXIS` |
| | δ = 0.5·tol, or regions on opposite sides (controls) | `ok` |
| `dependency` | a broken sketch with two consumers, followed by independent features | `DEPENDENCY_FAILED` for the consumers; the rest `ok` |
| `suppressed` | the consumed sketch is suppressed | `SKETCH_SUPPRESSED` |
| `rejected` | `RESERVED_NAME`, cross-part `DUPLICATE_NAME`, an unknown curve field, `INCONSISTENT_ARC`, a line of length exactly tol, `INVALID_ANGLE`, `INVALID_PLANE`, `UNRESOLVED_SKETCH` | rejected, exit 2 |

Every consumer of a broken sketch expects `DEPENDENCY_FAILED`.

**Runs with the current code:**

| Seed | Programs | Oracle failures | Error-corpus mismatches |
|---|---|---|---|
| 5 | 1000 | 1 | 0 |
| 3 | 3000 | 2 | 0 |
| 11 | 3000 | 0 | 0 |

All four oracle failures are OCCT defects, caught and reported as engine-internal errors:

| Seed / program | Code | What OCCT did |
|---|---|---|
| 5 / 724 | `OCCT_SELF_CHECK_FAILED` | Snapped a line 1.0e-4 rad off parallel to a cylinder |
| 3 / 2600 | `OCCT_SELF_CHECK_FAILED` | Returned a full turn for a 311.5° horn torus |
| 3 / 763 | `OCCT_INVALID_RESULT` | Built an invalid solid for a 120° revolve of a horn torus with r = 0.024 (rare: 1 of 143 small partial horn tori in a targeted sweep) |

## Known limitations

- **Validity is BRepCheck, not a self-intersection check.** It is not compared anyway [R-13].
- **Small float budget.** Exact-geometry numbers still carry one: volume ≤ 3e-11, area ≤ 1e-12, centroid ~1e-13·s relative. Golden files are not bit-reproducible across platforms or OCCT versions, so diff with tolerances.
- **Gate false alarms.** The 2D predicates are plain doubles. The gate can fire on legal edge cases: a line within 1e-9 rad of parallel with length/radius > ~10, where §4.4 says "cylinder" but no cylinder radius is specified. Such a case shows up as ROBUSTNESS, never as a silent pass.
- **Unreachable codes.** `SKETCH_DEGENERATE_LOOP` is preceded by `SKETCH_CURVES_CROSS` for every zero-area loop. `SKETCH_NO_REGIONS` is defensive only.

## Open spec points

Revision 2026-09-23b resolved the 15 points the oracle raised. These remain or are new:

1. **[R-4]'s wording, read literally, rejects legal sketches.** "Come within tol of each other at a location more than 2·tol from every shared endpoint" fails every tangent join and every small-angle corner, because such curves stay within tol along a stretch far longer than 2·tol. At a slot's tangent join that stretch is ≈ √(2·r·tol) ≈ 3.5e-3 mm. The oracle evaluates the rule on **contact points** (proper intersections, tangency points with gap ≤ tol, and end points within tol of the other curve), which is what was intended. The spec should say so.
2. **Non-empty part names are not enforced.** §0 says "a part name is any non-empty string", but neither the schema nor `validate.rs` rejects `""`. The oracle mirrors `validate.rs` and accepts it.
3. **The exact geometry of an in-tolerance classification is not stated.** A line within 1e-9 rad of parallel is a cylinder, but of which radius? The same question applies to a perpendicular line (plane) and to an arc whose centre is within tol of the axis (sphere radius). The effect is ≤ 1e-9·length, harmless for §6. The oracle builds OCCT's surface and gates at 1e-8.
4. **"Within tol of the axis ⇒ on the axis" is implied, not stated.** §4.4 speaks of profile vertices and edges "on the axis" without tying that to tol. The oracle snaps points within tol. State this explicitly.
5. **Class precedence within one program is unspecified.** The oracle uses POTENTIAL_SILENT_WRONG > CODE_MISMATCH > ROBUSTNESS > MATCH.
6. **Feature-list mismatches are unclassified.** A missing, extra or reordered feature entry in one report falls under no §6 class. The oracle calls it POTENTIAL_SILENT_WRONG.

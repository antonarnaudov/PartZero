# IR v0: normative semantics (`aicad.ir/0`)

Two engines implement this spec independently: **Forge** (Rust) and the **oracle** (`oracle/`, OCCT through build123d/OCP). For every valid document they must produce the same `aicad.metrics/0` report.

When the two engines disagree:
1. Decide which one violates this spec.
2. If the spec is ambiguous, fix the spec first. Then fix the engine.

The types are defined in `src/doc.rs` and `src/metrics.rs`, and the JSON Schemas are in `schema/`.

*Revision 2026-09-23b resolves the 15 ambiguities the oracle raised. Each rule it added carries an **[R-n]** tag.*

## 0. Identity and canonical form

**Uniqueness.**
- Feature `id`s and feature `name`s are unique across the whole **document**. Names are CadScript `const`s that share one file scope.
- Part ids and part names are unique among parts.
- Curve ids are unique within their sketch.

**Feature names.**
- A feature name matches `[A-Za-z_][A-Za-z0-9_]*`.
- It must not appear in `RESERVED_NAMES` (see `src/lib.rs` and `schema/ir-v0.constants.json`). A reserved name is rejected with `RESERVED_NAME`.

**Part names [R-15].**
- A part name is any non-empty string. Parts are written as `part("…")` in CadScript.
- Reserved names do not apply to part names.

**Unknown fields.** Unknown fields are rejected everywhere, including inside sketch curves.

**Canonical JSON.**
- Canonical JSON (`forge_ir::to_json`) omits every field that holds its default: `meta` when empty, `units`, `suppressed: false`, `regions: "all"`, `direction: "normal"` and `op: "new_body"`.
- Readers must accept both the explicit and the omitted form.

**Rejected documents [R-10].**
- A document that does not parse or fails structural validation is **rejected** and never evaluated.
- The CLI exits with code 2 and prints its diagnostics.
- In a diff, "both engines rejected" is `MATCH`. "Only one engine rejected" is `ROBUSTNESS`.

## 1. Units and tolerance
- Lengths are in millimetres and angles in degrees. No other units exist in v0.
- `LINEAR_TOLERANCE = 1e-6` mm (written *tol* below). **[R-3]** Every comparison is inclusive:
  - Two points **coincide** when `distance ≤ tol`.
  - A length is **degenerate** when `length ≤ tol`.
- The angular tolerance for classification is `1e-9` rad.

## 2. Planes
**Named planes:**

| Plane | x axis | y axis | normal |
|---|---|---|---|
| `"XY"` | +X | +Y | +Z |
| `"XZ"` | +X | +Z | −Y |
| `"YZ"` | +Y | +Z | +X |

**Explicit `Frame`** (`origin`, `normal`, `x_dir`):
1. `n = normalize(normal)`.
2. **[R-14]** `x = normalize(x_dir − (x_dir·n) n)`. The x direction is re-orthogonalised against the normal. Validation already guarantees `|cos| ≤ 1e-9`, so this only removes rounding error.
3. `y = n × x`.

A sketch point (u, v) maps to 3D as `origin + u·x + v·y`.

## 3. Sketch curves, loops and regions

**Curves:**
- **`line`** runs from `start` to `end`.
- **`arc`** has `start`, `end`, `center` and `ccw`.
  - It is traced counter-clockwise from `start` to `end` in the (u, v) plane when `ccw` is true, and clockwise otherwise.
  - Its sweep is in (0°, 360°).
  - **[R-6]** The carrier circle has centre `center` and radius r = |start − center|. The arc ends at the angle of `end − center`.
  - Its topological end point is exactly the given `end`. Validation lets `end` sit up to *tol* off the circle, and that gap is absorbed by the vertex tolerance.
- **`circle`** has a `center` and `radius`. It forms a closed loop by itself.

### 3.1 Loop assembly and sketch errors
A sketch is checked in **stages**. The first failing stage decides the error **[R-2]**. Within a stage, candidates are scanned in the order given, and the first one that fails is reported.

1. **Endpoints.**
   - Visit the curve ends in curve order, and within each curve `start` before `end`. Circles have no ends.
   - For each end, count the ends of *other* curves that coincide with it.
   - A count of 0 is `SKETCH_OPEN_LOOP`. A count of 2 or more is `SKETCH_BRANCHING`.
   - The first failing end determines the code.
2. **Crossings.**
   - Visit curve pairs (i, j) with i < j in lexicographic index order.
   - A pair fails with `SKETCH_CURVES_CROSS` when either of these holds **[R-4]**:
     - The two curves come within *tol* of each other at a location more than 2·*tol* from every endpoint they share.
     - They overlap along a length greater than *tol*.
   - Meeting at shared endpoints is allowed. No automatic splitting happens in v0.
3. **Degenerate loops.** A loop whose enclosed area is ≤ *tol*² is `SKETCH_DEGENERATE_LOOP` **[R-5]**. A loop of two curves, a line and an arc, is fine.
4. **No regions.** `SKETCH_NO_REGIONS` is defensive only. It cannot happen for a sketch that passes validation.

After these stages, the connected chains form closed loops, and each circle is its own loop.

### 3.2 Regions
- **Depth.** A loop's depth is the number of other loops that strictly contain it.
- **Region.** A region is a loop at even depth (its outer boundary) plus every loop at depth + 1 directly inside it (its holes).
- **Name.** A region is named by the **sorted list of the curve ids in its outer loop** (`outer_curves`).
- **Canonical order.** Regions sort by `outer_curves`, comparing the lists lexicographically.

## 4. Features

**Evaluation.**
- Features evaluate in timeline order. A suppressed feature is skipped and produces no report entry.
- A failed feature reports its error, and evaluation continues with the next feature. Any failure sets the document `status` to `error`.

**Dependency errors.**
- A feature that references a suppressed sketch fails with `SKETCH_SUPPRESSED`.
- **[R-1]** A feature that references a sketch that *failed* fails with `DEPENDENCY_FAILED`. Its message names the failed sketch and that sketch's code.

**Invalid results [R-12].**
- An engine must never report an invalid body as `ok`. If its own validity check fails on a body it produced, the feature fails.
- The feature then reports either the standard code `INVALID_RESULT` or an engine-prefixed internal code (e.g. `OCCT_INVALID_RESULT`, `FORGE_INTERNAL`).
- Engine-prefixed codes mark engine-internal failures. They are never compared as semantic codes (see §6).

### 4.1 `sketch`
- A sketch produces regions and no bodies.
- Its report lists `regions` in canonical order. Each entry has `area`, `loops` (1 + the number of holes) and `outer_curves`.

### 4.2 `extrude`
Each region, in canonical order, becomes **one new solid body**: the region swept along the plane normal n.

| `direction` | Sweep range |
|---|---|
| `normal` | 0 → +distance·n |
| `reverse` | 0 → −distance·n |
| `symmetric` | −distance/2·n → +distance/2·n |

### 4.3 `revolve`
**Axis.**
- The axis origin is `plane.origin + o_u·x + o_v·y`.
- The axis direction is `normalize(d_u·x + d_v·y)`.

**Rotation.**

| `direction` | Rotation |
|---|---|
| `normal` | +angle, right-hand rule about the axis direction |
| `reverse` | −angle |
| `symmetric` | [−angle/2, +angle/2] |

**Crossing the axis [R-7].**
- Let the signed distance of a point from the axis line (in the sketch plane) be *d*.
- A region **crosses the axis** when some of its points have *d* > *tol* and others have *d* < −*tol*.
- Each region is judged on its own. Different regions may lie on opposite sides of the axis.
- If any region crosses, the whole feature fails with `REVOLVE_CROSSES_AXIS` and produces no bodies.

**Result.**
- Each region becomes one new solid body.
- At 360° the body has no end caps. Below 360° it has two planar end-cap faces.

### 4.4 Generated topology and surface types (normative for counts and types) [R-8, R-9]

**Faces.**
- **Every sketch curve generates its own side face**, even where adjacent curves meet tangentially. Tangent faces are never merged.
- Extrude side faces:
  - a line gives a `plane`;
  - an arc or circle gives a `cylinder`.
- Revolve side faces are classified by how the profile curve sits relative to the axis (*tol* and 1e-9 rad as in §1):

| Profile curve | Surface |
|---|---|
| Line parallel to the axis, not on it | `cylinder` |
| Line perpendicular to the axis | `plane` |
| Line lying on the axis | no face |
| Any other line | `cone` |
| Arc whose centre is within *tol* of the axis | `sphere` |
| Any other arc or circle | `torus`, including horn tori (minor = major) and spindle-torus patches (minor > major) |

**Edges, vertices and singular points.**
- **Profile vertices on the axis** sweep to singular points. They create no edge and no vertex, and the surface simply has a singularity there (cone apex, sphere pole).
- **A profile edge lying on the axis:**
  - below 360°, it becomes **one** line edge shared by the two end caps;
  - at 360°, it produces nothing.
- **Profile vertices off the axis** sweep to circular edges: full circles (ring edges) at 360°, arcs below 360°.
- **Engines without seams.** Forge represents periodic faces without seam edges. Engines that do use seams (OCCT) exclude seam and degenerate edges from every count (§5).

## 5. Metrics (`aicad.metrics/0`)
- In each `FeatureReport`, `part` and `feature` are **names**, which are unique per §0.
- Every quantity is computed on the **exact** geometry, never on a tessellation.

| Field | Definition |
|---|---|
| `volume` | Solid volume, mm³ (> 0). |
| `area` | Sum of face areas, mm². |
| `centroid` | Centre of mass assuming uniform density. |
| `bbox_min` / `bbox_max` | Tight axis-aligned box of the exact geometry, not enlarged by tolerances. |
| `faces` | Number of faces. |
| `edges` | Number of edges, excluding seam edges and degenerate edges. |
| `face_types` | Histogram of canonical surface types per face: `plane`, `cylinder`, `cone`, `sphere`, `torus`, `bspline` or `other`. Classified per §4.4. |
| `edge_types` | Histogram of canonical curve types per counted edge: `line`, `circle`, `ellipse`, `bspline` or `other`. |
| `valid` | Always `true` in an `ok` feature, per §4 [R-12]. Kept for diagnostics. **[R-13]** It is not compared (see §6), because engines differ in what their checkers cover. |

`engine` is free text, for example `forge 0.0.1` or `occt 7.9.3 / build123d 0.12.0`.

## 6. Diff rules (`kernel-diff`) [R-11]

**Reports A (Forge) and B (oracle) match when every rule below holds.**

**Exact matches:**
- `status`
- per-feature `status`
- per-feature error `code`, when both engines report a **semantic** code. A semantic code is one without an engine prefix.
- region count, `loops`, `outer_curves`
- body count
- `faces`, `edges`, `face_types`, `edge_types`

**Tolerance matches:**
- Relative difference: `rel(a, b) = |a − b| / max(|a|, |b|)`.
- Absolute difference: `abs(a, b) = |a − b|`.
- Scale: `s = max(1, diagA, diagB)`, where `diag` is the length of that engine's bbox diagonal. For regions, `s = 1`.
- Vectors are compared **per component**.

| Quantity | Match when |
|---|---|
| `volume` | `rel ≤ 1e-6` or `abs ≤ 1e-9·s³` |
| `area`, region `area` | `rel ≤ 1e-6` or `abs ≤ 1e-9·s²` |
| `centroid`, `bbox_min`, `bbox_max` | each component `abs ≤ 1e-6·s` |

**Classification of each program:**

| Class | Meaning |
|---|---|
| `MATCH` | All rules hold, or both engines rejected the document. |
| `ROBUSTNESS` | Only one engine reported an error or rejected the document, or either engine reported an engine-prefixed internal error. |
| `CODE_MISMATCH` | Both engines failed the same feature with different **semantic** codes. The spec is ambiguous or one engine is wrong; always investigate. |
| `POTENTIAL_SILENT_WRONG` | Both engines reported `ok`, but exact or tolerance fields differ. The oracle is not presumed correct, and every case must be investigated. A release requires zero of these. |

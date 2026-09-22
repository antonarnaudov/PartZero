# IR v0: normative semantics (`aicad.ir/0`)

Two engines implement this spec independently: **Forge** (Rust) and the **oracle** (`oracle/`, OCCT through build123d/OCP). They must produce the same `aicad.metrics/0` report for every valid document. When the two engines disagree, the first step is to decide which one violates this spec. If the spec is ambiguous, fix the spec before touching either engine.

The types live in `src/doc.rs` and `src/metrics.rs`. The JSON Schemas generated from them are in `schema/`.

## 0. Identity and canonical form
- **Unique ids and names.** Feature `id`s and feature `name`s are unique across the whole **document**, not just within a part studio. This is because names are CadScript `const`s that share one file scope. Part ids and part names are unique among parts. Curve ids are unique within their sketch.
- **Name syntax.** Feature names match `[A-Za-z_][A-Za-z0-9_]*`. They must not be a reserved word or a CadScript builtin (`RESERVED_NAMES` in `src/lib.rs`, also exported in `schema/ir-v0.constants.json`). A violation is reported as `RESERVED_NAME`.
- **No unknown fields.** Unknown fields are rejected everywhere, including inside sketch curves.
- **Canonical JSON.** Canonical JSON (`forge_ir::to_json`) omits fields that equal their defaults (`meta` when empty, `units`, `suppressed: false`, `regions: "all"`, `direction: "normal"`, `op: "new_body"`). Readers must accept both the explicit and the omitted form.

## 1. Units and tolerance
- Lengths are in millimetres and angles are in degrees. v0 supports no other units.
- `LINEAR_TOLERANCE = 1e-6` mm:
  - Points closer than this are coincident.
  - A length at or below this is degenerate.

## 2. Planes
- `"XY"` has x = +X, y = +Y, normal = +Z.
- `"XZ"` has x = +X, y = +Z, normal = −Y.
- `"YZ"` has x = +Y, y = +Z, normal = +X.
- An explicit `Frame`:
  - Fields are `origin`, `normal` and `x_dir`.
  - `normal` and `x_dir` are normalised, and y = normal × x.
  - `normal` and `x_dir` must be perpendicular (|cos| ≤ 1e-9).
- A sketch point (u, v) maps to 3D as `origin + u·x + v·y`.

## 3. Sketch curves, loops and regions
Curves:
- **`line`** runs from `start` to `end`.
- **`arc`** has `start`, `end`, `center` and `ccw`.
  - The radius is r = |start − center|.
  - The arc runs from `start` to `end` counter-clockwise when `ccw` is true, and clockwise otherwise, as seen looking against the plane normal (i.e. in the standard orientation of the (u, v) plane).
  - Its sweep is in (0, 360).
- **`circle`** has `center` and `radius`. It is a closed loop by itself.

### 3.1 Loop assembly
1. **Endpoints.** Every endpoint of a line or arc must coincide, within tolerance, with the endpoint of exactly one other curve end.
   - If an endpoint has no partner, the error is `SKETCH_OPEN_LOOP`.
   - If it has more than one partner, the error is `SKETCH_BRANCHING`.
2. **Loops.** The connected chains form closed loops, and each circle is its own loop.
3. **No crossings.** Curves may only meet at shared endpoints. Any other intersection or touch between two curves, in the same loop or in different loops, is `SKETCH_CURVES_CROSS`. v0 has no automatic splitting.
4. **No degenerate loops.** A loop must enclose non-zero area. A two-curve loop made of a line and an arc is fine. Zero-area loops are `SKETCH_DEGENERATE_LOOP`.

### 3.2 Regions
- **Nesting.** Each loop's *depth* is the number of other loops that strictly contain it.
- **Region shape.** A region is a loop at even depth (its outer boundary) plus every loop at depth + 1 directly inside it (its holes).
- **Region name.** A region is named by the **sorted list of the curve ids in its outer loop** (`outer_curves`).
- **Canonical region order.** Regions are sorted by `outer_curves`, compared lexicographically as lists of strings. Every region-ordered output uses this order.
- **No regions.** If a sketch yields no regions, the error is `SKETCH_NO_REGIONS`.

## 4. Features
- **Timeline.** Features evaluate in timeline order.
- **Suppressed features.** A suppressed feature is skipped and produces no report entry.
- **References.** A feature that references a suppressed sketch fails with `SKETCH_SUPPRESSED`.
- **Failures.** A failed feature reports its error. Evaluation continues with the next feature, and the document `status` becomes `error`.

### 4.1 `sketch`
Produces regions only; no bodies. The report lists `regions` in canonical order, with `area`, `loops` (1 + number of holes) and `outer_curves`.

### 4.2 `extrude`
Each region of the referenced sketch (in canonical order) becomes **one new solid body**: the region swept along the plane normal n.
- `normal` sweeps from 0 to +distance·n.
- `reverse` sweeps from 0 to −distance·n.
- `symmetric` sweeps from −distance/2·n to +distance/2·n.

### 4.3 `revolve`
**Axis.**
- The axis origin in 3D is `plane.origin + o_u·x + o_v·y`.
- The axis direction in 3D is `d_u·x + d_v·y`, normalised.

**Rotation.**
- `normal` rotates by +angle, right-hand rule about the axis direction.
- `reverse` rotates by −angle.
- `symmetric` rotates over [−angle/2, +angle/2].

**Profile rules.**
- Every region must lie in one closed half-plane of the sketch bounded by the axis line.
- Regions may touch the axis, at points or along whole edges. A region that touches the axis only at isolated points is still valid.
- A region with points strictly on both sides of the axis is `REVOLVE_CROSSES_AXIS`.
- Profile edges that lie on the axis generate no faces.

**Result.**
- Each region becomes one new solid body.
- With angle = 360 the body has no end caps.
- With angle < 360 there are two planar end-cap faces.

## 5. Metrics (`aicad.metrics/0`)

In `FeatureReport`, the `part` and `feature` fields hold the part **name** and the feature **name**. Both are unique across the document, per §0.

Every quantity is computed on the **exact** geometry, never on a tessellation.

| Field | Definition |
|---|---|
| `volume` | Solid volume, mm³ (> 0). |
| `area` | Sum of face areas, mm². |
| `centroid` | Centre of mass at uniform density. |
| `bbox_min` / `bbox_max` | Tight axis-aligned box of the exact geometry. Not enlarged by tolerances. |
| `faces` | Number of faces. |
| `edges` | Number of edges, **excluding seam edges and degenerate edges** (such as OCCT's degenerated edges at cone apexes and sphere poles). Forge has neither kind. |
| `face_types` | Histogram of the **canonical** surface type of each face: `plane`, `cylinder`, `cone`, `sphere`, `torus`, `bspline` or `other`. A surface of revolution or extrusion that is exactly one of the analytic types is reported as that type. |
| `edge_types` | Histogram of the canonical curve type of each counted edge: `line`, `circle`, `ellipse`, `bspline` or `other`. |
| `valid` | The engine's own validity check: closed, consistently oriented, no self-intersections. |

**Engine identifier.** `engine` is free text, e.g. `forge 0.0.1` or `occt 7.8.1 / build123d 0.9.1`.

## 6. Diff rules (`kernel-diff`)

Two reports match when all of the following hold.

**Must match exactly:**
- `status`
- the per-feature `status` and error `code` (messages may differ)
- region count
- `loops` and `outer_curves`
- body count
- `faces`, `edges`, `face_types`, `edge_types`
- `valid`

**Must match within tolerance** (s = max(1, bbox diagonal of the body)):

| Quantity | Tolerance |
|---|---|
| `volume` | Relative 1e-6 (absolute floor 1e-9·s³) |
| `area` | Relative 1e-6 (absolute floor 1e-9·s²) |
| region `area` | Relative 1e-6 (absolute floor 1e-9·s²) |
| `centroid` | Absolute 1e-6·s |
| `bbox_min` / `bbox_max` | Absolute 1e-6·s |

**Classifying a mismatch:**
- A difference where one engine reports an error the other doesn't is a **robustness difference**.
- A metric difference where both engines report `ok` is a **potential silent-wrong result**. The oracle is not presumed correct, so every such case must be investigated.

/**
 * # `@aicad/std` v1 — the CadScript v1 standard library (`aicad.ir/1`)
 *
 * CadScript is a statically compiled subset of TypeScript. A `.cad.ts` file is **parsed and
 * compiled** to the Feature-Graph IR v1; it is **never executed**. These declarations give editors,
 * `tsc` and agents types, completions and documentation. Semantics: `forge-ir/SPEC-v1-DRAFT.md`.
 *
 * ```ts
 * import { doc, part, sketch, extrude, XY, param, rect, fillet, hole, grid, Z } from "@aicad/std";
 *
 * doc({ name: "plate" });
 *
 * const width = param(80, { min: 20, max: 300, note: "outer width" }); // mm
 * const depth = param(50);
 * const thick = param(8, { min: 2 });
 *
 * part("plate");
 * const base = sketch(XY, { outline: rect({ center: [0, 0], w: width, h: depth, r: 4 }) });
 * const slab = extrude(base, { distance: thick });
 * const corners = fillet(slab.sides().edges().parallel(Z), { r: 2 });
 * const mounts = hole(slab.cap("end"), { at: grid({ nx: 2, ny: 2, dx: width - 12, dy: depth - 12 }), size: "M4", depth: "through" });
 * ```
 *
 * ## Rules of CadScript v1
 * - **Units:** lengths are millimetres, angles are degrees. `mm(…)`, `cm(…)`, `inch(…)` and
 *   `deg(…)` write other length units explicitly; they always evaluate to mm and degrees.
 * - **Statements:** `import { … } from "@aicad/std"`, optionally one `doc({ … })`, document
 *   parameters (`const x = param(…)` before the first part), then `part("name")` followed by that
 *   part's parameters and features. Several parts are allowed.
 * - **One const per parameter or feature.** The const name *is* the parameter or feature name:
 *   `[A-Za-z_][A-Za-z0-9_]*`, at most 64 characters, unique in the file. Features run in file
 *   order and may only use parameters and features declared above them. A const may also name a
 *   query (`const topFace = slab.faces().planes().max("+Z").one();`): an alias, written out in
 *   place wherever it is used (it is not stored in the IR, and printing writes the query inline);
 *   for a named reference that the IR keeps, use {@link tag}.
 * - **Expressions:** numeric arguments accept arithmetic over parameters: `+ - * / %`, `**`,
 *   comparisons, `&& || !`, `c ? a : b` and the math functions of this module (degrees), nested
 *   up to 64 levels. They are stored in the IR as canonical expression strings and evaluated by
 *   the engine; a bare literal (`-2.5`, `-0`) is stored as a number. `Math.*`, `let`/`var`
 *   (derived values are `param(expression)`), loops, `if`, functions, template strings, spreads
 *   and bitwise operators (`^` is XOR in TypeScript: write `**`) are not CadScript.
 * - **Units are checked by the compiler:** `width + holes` (mm + count) or `sin(width)` are
 *   errors (`EXPR_UNIT_MISMATCH`). A bare number next to a length is a length (`width - 12`), a
 *   bare factor is dimensionless (`2 * wall`).
 * - **References are queries**, written as method chains on feature handles
 *   (`slab.cap("end")`, `slab.sides().edges().parallel(Z)`), with an optional declared count at
 *   the end (`.one()`, `.some()`, `.any()`, `.exactly(4)`). A reference whose count does not match
 *   fails its feature loudly instead of silently picking something else.
 * - **Tolerance:** points closer than `1e-6` mm coincide; lengths at or below `1e-6` mm are
 *   degenerate.
 *
 * @packageDocumentation
 */

declare const brand: unique symbol;

// ─── Values ──────────────────────────────────────────────────────────────────────────────────

/**
 * A numeric value: a literal (`8`, `-2.5`), a {@link param} or an arithmetic expression over
 * parameters (`width - 2 * wall`). Lengths are mm, angles degrees, counts whole numbers.
 */
export type Scalar = number;

/** A boolean value: `true`, `false`, a bool {@link param} or a condition (`!withLid`, `holes > 2`). */
export type BoolScalar = boolean;

/** A 2D point or vector in **sketch coordinates** `[u, v]`, mm. Components may be expressions. */
export type Vec2 = readonly [u: Scalar, v: Scalar];

/** A 3D point `[x, y, z]` in model coordinates (mm), or a direction (components are ratios). */
export type Vec3 = readonly [x: Scalar, y: Scalar, z: Scalar];

/** `"start"` or `"end"`: of a sweep (its caps) or of a curve (its ends). */
export type End = "start" | "end";

// ─── Parameters ──────────────────────────────────────────────────────────────────────────────

/** Parameter units (SPEC-v1 §2.1). */
export type ParamUnit =
  /** a length in millimetres (the default for numbers) */
  | "mm"
  /** an angle in degrees */
  | "deg"
  /** a dimensionless real */
  | "ratio"
  /** a dimensionless whole number (|n| ≤ 2³¹) */
  | "count"
  /** a boolean */
  | "bool";

/** Options of a numeric {@link param}. */
export interface ParamOptions {
  /**
   * The unit. Default: inferred — a number literal is `"mm"`; an expression takes the unit of its
   * type (`width - 2` is mm, `tilt * 2` is deg, `holes - 1` is ratio); give `"count"` for whole
   * numbers used as counts.
   */
  readonly unit?: "mm" | "deg" | "ratio" | "count";
  /** Inclusive lower bound, checked after evaluation (`PARAM_OUT_OF_RANGE`). May be an expression. */
  readonly min?: Scalar;
  /** Inclusive upper bound, checked after evaluation (`PARAM_OUT_OF_RANGE`). May be an expression. */
  readonly max?: Scalar;
  /** Free text shown next to the parameter in the UI; not semantic. */
  readonly note?: string;
}

/** Options of a boolean {@link param}. */
export interface BoolParamOptions {
  readonly unit?: "bool";
  /** Free text; not semantic. */
  readonly note?: string;
}

/**
 * Declare a named parameter: the const name is the parameter name. Declared before the first
 * `part(…)` it is a **document** parameter (visible in every part); inside a part it is that
 * part's parameter. A literal value makes a **driving** parameter (a UI slider); an expression
 * makes a **derived** one.
 *
 * @param value A number (mm unless `unit` says otherwise), a boolean, or an expression over
 *   earlier parameters.
 * @returns The parameter, usable in any numeric (or boolean) argument.
 * @example
 * const width = param(80, { min: 20, max: 300, note: "outer width" }); // unit defaults to "mm"
 * const wall  = param(2);
 * const inner = param(width - 2 * wall);        // derived: mm, inferred
 * const holes = param(4, { unit: "count", min: 1 });
 * const tilt  = param(15, { unit: "deg" });
 * const withLid = param(true);                   // bool
 */
export declare function param(value: boolean, options?: BoolParamOptions): boolean;
export declare function param(value: Scalar, options?: ParamOptions): number;

/**
 * A measured parameter: the value of a reference dimension of a sketch.
 * @deprecated Measured parameters arrive with IR v1.1 (ADR 0013 decision 5); the compiler
 * rejects this call with `PARAM_INVALID` (reason `measure-deferred`).
 */
export declare function measure(sketch: Sketch, constraint: string): number;

// ─── Math (degrees) ──────────────────────────────────────────────────────────────────────────

/** π (to f64 precision). Dimensionless. */
export declare const PI: number;
/** The smallest argument (same unit for all); on ties the first. At least two arguments. */
export declare function min(a: Scalar, b: Scalar, ...more: Scalar[]): number;
/** The largest argument (same unit for all); on ties the first. At least two arguments. */
export declare function max(a: Scalar, b: Scalar, ...more: Scalar[]): number;
/** Absolute value (keeps the unit). */
export declare function abs(x: Scalar): number;
/** Square root; the unit's exponents must be even (`sqrt(area)` of mm² is mm). `x < 0` fails. */
export declare function sqrt(x: Scalar): number;
/** Largest whole number ≤ x (keeps the unit). */
export declare function floor(x: Scalar): number;
/** Smallest whole number ≥ x (keeps the unit). */
export declare function ceil(x: Scalar): number;
/** Nearest whole number, halves away from zero (keeps the unit). */
export declare function round(x: Scalar): number;
/** `min(max(x, lo), hi)`; all three in one unit; `lo > hi` fails. */
export declare function clamp(x: Scalar, lo: Scalar, hi: Scalar): number;
/** √(a² + b²) without overflow; `a` and `b` in one unit. */
export declare function hypot(a: Scalar, b: Scalar): number;
/** Sine of an angle in **degrees** (exact at multiples of 30° and 45°). */
export declare function sin(degrees: Scalar): number;
/** Cosine of an angle in **degrees**. */
export declare function cos(degrees: Scalar): number;
/** Tangent of an angle in **degrees**; fails where cos = 0. */
export declare function tan(degrees: Scalar): number;
/** Arcsine in **degrees** of a ratio in [−1, 1]. */
export declare function asin(ratio: Scalar): number;
/** Arccosine in **degrees** of a ratio in [−1, 1]. */
export declare function acos(ratio: Scalar): number;
/** Arctangent in **degrees**. */
export declare function atan(ratio: Scalar): number;
/** Angle of the vector (x, y) in **degrees**, in (−180, 180]; `y` and `x` in one unit. */
export declare function atan2(y: Scalar, x: Scalar): number;

/** A length in millimetres (the default unit; `mm(12)` is `12`). Numeric literal argument only. */
export declare function mm(value: number): number;
/** A length in centimetres: `cm(2)` is 20 mm. Numeric literal argument only. */
export declare function cm(value: number): number;
/** A length in inches: `inch(0.25)` is 6.35 mm. Numeric literal argument only. */
export declare function inch(value: number): number;
/** An angle in degrees (explicitly): `deg(30)`. Numeric literal argument only. */
export declare function deg(value: number): number;

// ─── Document structure ──────────────────────────────────────────────────────────────────────

/** Document metadata. At most once, directly after the imports. */
export declare function doc(meta: { readonly name?: string; readonly description?: string }): void;

/**
 * Start a part studio: the parameters and features that follow belong to it until the next
 * `part(…)`. The name matches `[A-Za-z_][A-Za-z0-9_]*` and is unique in the file.
 */
export declare function part(name: string): void;

/** Options every feature accepts. */
export interface FeatureOptions {
  /** Skip the feature (it produces nothing). A bool expression is allowed: `suppressed: !withLid`. */
  readonly suppressed?: BoolScalar;
  /** Behavior version (SPEC-v1 §0.2); omit it — the command layer upgrades features explicitly. */
  readonly v?: number;
  /** Free text, not semantic. */
  readonly note?: string;
  /** Why the feature exists (free text, not semantic). */
  readonly intent?: string;
  /** Who wrote it (free text, not semantic). */
  readonly author?: string;
  /** Assumptions made (free text, not semantic). */
  readonly assumptions?: readonly string[];
  /** Decision records it implements (not semantic). */
  readonly decisionIds?: readonly string[];
}

// ─── Planes, axes, directions ────────────────────────────────────────────────────────────────

/** A plane constant or {@link frame}. */
export interface Plane {
  readonly [brand]: "plane";
}
/** XY: x = +X, y = +Y, **normal +Z**. Sketch `[u, v]` is 3D `(u, v, 0)`. */
export declare const XY: Plane;
/** XZ: x = +X, y = +Z, **normal −Y**. Sketch `[u, v]` is 3D `(u, 0, v)`. */
export declare const XZ: Plane;
/** YZ: x = +Y, y = +Z, **normal +X**. Sketch `[u, v]` is 3D `(0, u, v)`. */
export declare const YZ: Plane;

/**
 * An explicit right-handed plane: sketch `[u, v]` maps to `origin + u·x + v·y` with
 * `x = normalize(xDir)`, `y = normalize(normal) × x`. `normal` and `xDir` must be perpendicular.
 * @example sketch(frame({ origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] }), { … })
 */
export declare function frame(spec: { readonly origin: Vec3; readonly normal: Vec3; readonly xDir: Vec3 }): Plane;

/**
 * Where a sketch (or hole, datum, mirror) lies:
 * - {@link XY}, {@link XZ}, {@link YZ} or a {@link frame};
 * - a **planar face** (a face query, one face): `slab.cap("end")`, a {@link tag} of a face. Its
 *   frame follows the face when upstream dimensions change: origin = the world origin projected
 *   onto the face, normal = the outward normal, x = the world axis least aligned with it
 *   (SPEC-v1 §3.1). `{ face, origin, xDir }` overrides origin and x;
 * - a {@link datumPlane} handle.
 */
export type PlaneRef = Plane | FaceSel | DatumPlane | { readonly face: FaceSel; readonly origin?: Vec3; readonly xDir?: Vec3 };

/** The world axis +X (unsigned where a sign does not matter). */
export declare const X: Axis;
/** The world axis +Y (unsigned where a sign does not matter). */
export declare const Y: Axis;
/** The world axis +Z (unsigned where a sign does not matter). */
export declare const Z: Axis;
/** A world axis constant: {@link X}, {@link Y}, {@link Z}. */
export interface Axis {
  readonly [brand]: "axis";
}

/**
 * An oriented line:
 * - {@link X}, {@link Y}, {@link Z} through the world origin;
 * - a {@link datumAxis} handle;
 * - `{ edge: <edge query> }`: a line edge, or a circular edge's axis (through its centre);
 * - `{ cylinder: <face query> }`: the axis of a cylindrical or conical face;
 * - `{ line: { origin: [x, y, z], direction: [dx, dy, dz] } }`: explicit;
 * - any of the object forms with `flip: true` reverses the direction. A bare edge query means
 *   `{ edge }` and a bare face query means `{ cylinder }`.
 * Directions of edges and faces are made sign-canonical (first non-zero component positive).
 */
export type AxisRef =
  | Axis
  | DatumAxis
  | EdgeSel
  | FaceSel
  | { readonly edge: EdgeSel; readonly flip?: BoolScalar }
  | { readonly cylinder: FaceSel; readonly flip?: BoolScalar }
  | { readonly datum: DatumAxis; readonly flip?: BoolScalar }
  | { readonly line: { readonly origin: Vec3; readonly direction: Vec3 }; readonly flip?: BoolScalar };

/** A signed world direction. */
export type SignedDir = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

/**
 * A direction: {@link X}/{@link Y}/{@link Z} (unsigned: parallel tests ignore the sign; where a
 * sign is needed they mean +), a signed string `"+Z"`/`"-X"`, a vector `[x, y, z]`, or an
 * {@link AxisRef} (its direction).
 */
export type Dir = SignedDir | Vec3 | AxisRef;

/** A point in model coordinates: `[x, y, z]` (mm) or a vertex query (one vertex). */
export type PointRef = Vec3 | VertexSel;

// ─── Queries ─────────────────────────────────────────────────────────────────────────────────

/** A face type for {@link Faces.ofType}. */
export type FaceType = "plane" | "cylinder" | "cone" | "sphere" | "torus" | "bspline";
/** An edge type for {@link Edges.ofType}. */
export type EdgeType = "line" | "circle" | "ellipse" | "bspline";
/** A radius range (mm, inclusive) for `.radius(…)`; `{ eq }` or `{ min?, max? }`. */
export interface RadiusRange {
  readonly eq?: Scalar;
  readonly min?: Scalar;
  readonly max?: Scalar;
}

/**
 * A reference with a declared count, created by `.one()`, `.some()`, `.any()` or `.exactly(n)`
 * at the end of a query chain. The count is checked on every regeneration.
 */
export interface Ref<K extends "face" | "edge" | "vertex" | "body"> {
  readonly [brand]: `ref:${K}`;
}

interface Counted<K extends "face" | "edge" | "vertex" | "body"> {
  /** Exactly one entity (0 → `REF_MISSING`, 2+ → `REF_AMBIGUOUS`, a split → `REF_SPLIT`). */
  one(): Ref<K>;
  /** At least one entity (0 → `REF_MISSING`). */
  some(): Ref<K>;
  /** Any number, including none. */
  any(): Ref<K>;
  /** Exactly `n ≥ 1` entities (`REF_CARDINALITY` otherwise). */
  exactly(n: number): Ref<K>;
}

/**
 * A set of **faces**: the result of a query, re-evaluated at every regeneration. Chain filters
 * and picks to narrow it; end with a count (`.one()`, …) to declare how many it must match.
 * Without a count a field's default applies (`one` for single-face fields, else `some`).
 */
export interface Faces extends Counted<"face"> {
  readonly [brand]: "faces";
  /** The boundary edges of these faces. */
  edges(): Edges;
  /** The vertices of these faces. */
  vertices(): Vertices;
  /** The bodies these faces belong to. */
  owner(): Bodies;
  /** Union: these faces and the others'. */
  and(...others: Faces[]): Faces;
  /** Intersection: the faces also in every other set. */
  common(...others: Faces[]): Faces;
  /** Difference: these faces except those in `other`. */
  minus(other: Faces): Faces;
  /** Planar faces only. */
  planes(): Faces;
  /** Cylindrical faces only. */
  cylinders(): Faces;
  /** Conical faces only. */
  cones(): Faces;
  /** Spherical faces only. */
  spheres(): Faces;
  /** Toroidal faces only. */
  tori(): Faces;
  /** Faces of one surface type. */
  ofType(type: FaceType): Faces;
  /** Planar faces whose **outward** normal equals the signed direction: `.normal("+Z")` is "top". */
  normal(dir: Dir): Faces;
  /** Planes containing the direction, and cylinders/cones whose axis is parallel to it. */
  parallel(dir: Dir): Faces;
  /** Planes whose normal is parallel to the direction (either sign). */
  perpendicular(dir: Dir): Faces;
  /** Cylinders/spheres (tori: minor radius) of radius `r` (±1e-6 mm), or within a range, mm. */
  radius(r: Scalar | RadiusRange): Faces;
  /** The faces whose centroid is furthest along `dir`. */
  max(dir: Dir): Faces;
  /** The faces whose centroid is furthest against `dir`. */
  min(dir: Dir): Faces;
  /** The faces of largest area. */
  largest(): Faces;
  /** The faces of smallest area. */
  smallest(): Faces;
}

/** A set of **edges** (see {@link Faces} for how queries work). */
export interface Edges extends Counted<"edge"> {
  readonly [brand]: "edges";
  /** The faces adjacent to these edges (two per edge). */
  faces(): Faces;
  /** The vertices of these edges. */
  vertices(): Vertices;
  /** The bodies these edges belong to. */
  owner(): Bodies;
  and(...others: Edges[]): Edges;
  common(...others: Edges[]): Edges;
  minus(other: Edges): Edges;
  /** Straight edges only. */
  lines(): Edges;
  /** Circular edges only. */
  circles(): Edges;
  /** Edges of one curve type. */
  ofType(type: EdgeType): Edges;
  /** Straight edges parallel to the direction (either sign): `.parallel(Z)` = vertical edges. */
  parallel(dir: Dir): Edges;
  /** Straight edges perpendicular to the direction, and circles whose normal is parallel to it. */
  perpendicular(dir: Dir): Edges;
  /** Convex edges (material angle < 180°): the ones a fillet rounds off. */
  convex(): Edges;
  /** Concave edges (material angle > 180°): inside corners. */
  concave(): Edges;
  /** Smooth (tangent) edges. */
  smooth(): Edges;
  /** Circular edges of radius `r` (±1e-6 mm), or within a range, mm. */
  radius(r: Scalar | RadiusRange): Edges;
  max(dir: Dir): Edges;
  min(dir: Dir): Edges;
  /** The longest edges. */
  largest(): Edges;
  /** The shortest edges. */
  smallest(): Edges;
}

/** A set of **vertices** (see {@link Faces}). Vertices have no size: no largest/smallest. */
export interface Vertices extends Counted<"vertex"> {
  readonly [brand]: "vertices";
  /** The faces meeting at these vertices. */
  faces(): Faces;
  /** The edges meeting at these vertices. */
  edges(): Edges;
  /** The bodies these vertices belong to. */
  owner(): Bodies;
  and(...others: Vertices[]): Vertices;
  common(...others: Vertices[]): Vertices;
  minus(other: Vertices): Vertices;
  /** The vertices furthest along `dir`. */
  max(dir: Dir): Vertices;
  /** The vertices furthest against `dir`. */
  min(dir: Dir): Vertices;
}

/** A set of **bodies** (see {@link Faces}). */
export interface Bodies extends Counted<"body"> {
  readonly [brand]: "bodies";
  /** Every face of these bodies. */
  faces(): Faces;
  /** Every edge of these bodies. */
  edges(): Edges;
  /** Every vertex of these bodies. */
  vertices(): Vertices;
  and(...others: Bodies[]): Bodies;
  common(...others: Bodies[]): Bodies;
  minus(other: Bodies): Bodies;
  max(dir: Dir): Bodies;
  min(dir: Dir): Bodies;
  /** The bodies of largest volume. */
  largest(): Bodies;
  /** The bodies of smallest volume. */
  smallest(): Bodies;
}

/** A face query or a counted face reference. */
export type FaceSel = Faces | Ref<"face">;
/** An edge query or a counted edge reference. */
export type EdgeSel = Edges | Ref<"edge">;
/** A vertex query or a counted vertex reference. */
export type VertexSel = Vertices | Ref<"vertex">;
/** A body query or a counted body reference. */
export type BodySel = Bodies | Ref<"body">;

/**
 * Bodies to operate on: a body query, or a feature handle meaning the bodies it created
 * (`targets: slab` is `slab.body()`).
 */
export type BodyTargets = BodySel | Extrude | Revolve | Pattern;

/** Body targets of `op: "join" | "cut" | "intersect"`: bodies, or `"all"` (every body in scope). */
export type Targets = BodyTargets | "all";

/** Every body in scope (the part's bodies just before the feature). */
export declare function bodies(): Bodies;

/**
 * The edges where a face of `a` meets a face of `b`: the robust way to name an edge
 * (`edgesBetween(boss.side("ring"), slab.cap("end"))` is the ring where a boss meets the plate).
 */
export declare function edgesBetween(a: Faces, b: Faces): Edges;

/** Same as `feature.side(curve)`: the side faces swept from a sketch curve. */
export declare function faceOf(feature: Extrude | Revolve, curve: string): Faces;

/** Same as `feature.body(member)`: the bodies a feature created. */
export declare function body(feature: Extrude | Revolve | Pattern, member?: string): Bodies;

// ─── Feature handles ─────────────────────────────────────────────────────────────────────────

/** Faces a feature created (its provenance), optionally one role (`"tip"`, `"blend"`, …). */
interface Creates {
  /** Every face this feature created (with `role`: only those of that role label). */
  faces(options?: { readonly role?: string }): Faces;
}

/** The handle of a {@link sketch}. */
export interface Sketch {
  readonly [brand]: "sketch";
  /**
   * Hole positions at sketch points (`point` curves or `<circle>.center`), projected onto the
   * hole's plane; no ids means every `point` curve in curve order.
   * @example hole(boss.cap("end"), { at: bossSk.points("p1", "p2"), size: "M3", insert: "std" })
   */
  points(...ids: string[]): HolePlacement;
}

/** Options of `.cap()`, `.endcap()` and `.sides()`: the body (by one of its region's curves). */
export interface BodyMember {
  /** A curve id of the body's region outer loop, e.g. `"outline.bottom"`: selects that body only. */
  readonly body?: string;
}

/** The handle of an {@link extrude}: queries name its faces by where they came from. */
export interface Extrude extends Creates {
  readonly [brand]: "extrude";
  /** The start cap (on the sketch plane) or the end cap (at `distance`). */
  cap(end: End, options?: BodyMember): Faces;
  /** The side faces swept from sketch curve `curve` (`"outline.left"` for a rect member). */
  side(curve: string): Faces;
  /** Every side face. */
  sides(options?: BodyMember): Faces;
  /** The edge swept from the sketch vertex at `curve`'s `end` (e.g. one vertical corner edge). */
  edgeAt(curve: string, end: End): Edges;
  /** The bodies it created (with `member`: the body whose region contains that curve). */
  body(member?: string): Bodies;
}

/** The handle of a {@link revolve}. */
export interface Revolve extends Creates {
  readonly [brand]: "revolve";
  /** The flat end cap at the start or end angle (below 360°). */
  endcap(end: End, options?: BodyMember): Faces;
  /** The faces swept from sketch curve `curve`. */
  side(curve: string): Faces;
  /** Every swept face. */
  sides(options?: BodyMember): Faces;
  /** The circular edge swept from the sketch vertex at `curve`'s `end`. */
  edgeAt(curve: string, end: End): Edges;
  /** The bodies it created. */
  body(member?: string): Bodies;
}

/** The handle of a {@link hole}: its faces per position id. */
export interface Hole extends Creates {
  readonly [brand]: "hole";
  /** The cylindrical wall at position `at`. */
  wall(at: string): Faces;
  /** The drill-point cone of a blind hole. */
  tip(at: string): Faces;
  /** The flat floor of a blind hole with `tip: "flat"`, an `upTo` hole or an insert. */
  floor(at: string): Faces;
  /** The counterbore wall. */
  cboreWall(at: string): Faces;
  /** The counterbore floor. */
  cboreFloor(at: string): Faces;
  /** The countersink cone. */
  csink(at: string): Faces;
}

/** The handle of a pattern ({@link linearPattern}, {@link circularPattern}, {@link mirror}). */
export interface Pattern extends Creates {
  readonly [brand]: "pattern";
  /** Every face of instance `i` (or `(i, j)` of a two-direction pattern); 0 is the seed. */
  instance(i: number, j?: number): Faces;
  /** The bodies a body-seed pattern created. */
  body(member?: string): Bodies;
}

/** The handle of a feature that modifies bodies: {@link boolean}, {@link fillet}, … */
export interface Modifier extends Creates {
  readonly [brand]: "modifier";
}

/** The handle of a {@link datumPlane}: usable wherever a plane is. */
export interface DatumPlane {
  readonly [brand]: "datum_plane";
}

/** The handle of a {@link datumAxis}: usable wherever an axis or direction is. */
export interface DatumAxis {
  readonly [brand]: "datum_axis";
}

// ─── Sketches ────────────────────────────────────────────────────────────────────────────────

/** A sketch curve (the object key is its id). */
export interface Curve {
  readonly [brand]: "curve";
}

/** Common curve option. */
export interface CurveOptions {
  /** Construction geometry: used by constraints and queries, never part of a profile loop. */
  readonly construction?: boolean;
}

/** A line segment `start → end` (sketch coordinates, mm); longer than 1e-6 mm. */
export declare function line(start: Vec2, end: Vec2, options?: CurveOptions): Curve;

/**
 * A circular arc from `start` to `end` around `center`, counter-clockwise when `ccw`.
 * `|start − center|` must equal `|end − center|` (±1e-6 mm) in an unconstrained sketch.
 */
export declare function arc(spec: { readonly start: Vec2; readonly end: Vec2; readonly center: Vec2; readonly ccw: boolean; readonly construction?: boolean }): Curve;

/** A full circle (radius in mm, > 1e-6). */
export declare function circle(spec: { readonly center: Vec2; readonly radius: Scalar; readonly construction?: boolean }): Curve;

/** A sketch point: never part of a loop; for constraints, hole positions (`sk.points(…)`) and queries. */
export declare function point(at: Vec2, options?: CurveOptions): Curve;

/**
 * A rectangle (compound curve), by `center` or lower-left `corner` (exactly one), with optional
 * corner radius `r` (0 ≤ r ≤ min(w, h)/2). Expands into members `<id>.bottom`, `.right`, `.top`,
 * `.left` and, with `r > 0`, corner arcs `.c_br`, `.c_tr`, `.c_tl`, `.c_bl` — the names queries use
 * (`slab.side("outline.left")`).
 * @example outline: rect({ center: [0, 0], w: width, h: depth, r: 4 })
 */
export declare function rect(spec: {
  readonly center?: Vec2;
  readonly corner?: Vec2;
  /** Width along u, mm. */
  readonly w: Scalar;
  /** Height along v, mm. */
  readonly h: Scalar;
  /** Corner radius, mm (default 0). */
  readonly r?: Scalar;
  readonly construction?: boolean;
}): Curve;

/**
 * A straight slot of width `w` with round ends centred on `a` and `b` (compound curve: members
 * `.right`, `.cap_b`, `.left`, `.cap_a`).
 * @example vent: slot({ a: [-10, 20], b: [10, 20], w: 3 })
 */
export declare function slot(spec: { readonly a: Vec2; readonly b: Vec2; readonly w: Scalar; readonly construction?: boolean }): Curve;

/**
 * A regular polygon with `n ≥ 3` sides (compound curve: members `.e0` … `.e<n−1>`), sized by
 * exactly one of `circumradius`, `inradius`, `acrossFlats`, `side`. Vertex 0 is at angle
 * `rotation` (degrees, default 0) from +u, so a hexagon's flats are parallel to u.
 * @example hex: polygon({ n: 6, acrossFlats: 5.5 })   // centre defaults to [0, 0]
 */
export declare function polygon(spec: {
  /** Centre, mm (default `[0, 0]`). */
  readonly center?: Vec2;
  /** Number of sides (a count ≥ 3). */
  readonly n: Scalar;
  readonly circumradius?: Scalar;
  readonly inradius?: Scalar;
  /** Distance between opposite flats (a wrench size), mm. */
  readonly acrossFlats?: Scalar;
  /**
   * The same option as `acrossFlats`, spelled as in the IR and SPEC-v1 §4.1
   * (`polygon({ n: 6, across_flats: 5.5 })`); give one of the two. Printed as `acrossFlats`.
   */
  readonly across_flats?: Scalar;
  /** Side length, mm. */
  readonly side?: Scalar;
  /** Angle of vertex 0 from +u, degrees. */
  readonly rotation?: Scalar;
  readonly construction?: boolean;
}): Curve;

/** A sketch constraint built with {@link C}. */
export interface Constraint {
  readonly [brand]: "constraint";
}

/** Options of a dimension constraint. */
export interface DimensionOptions {
  /** `false`: a reference (measured) dimension, which takes no value. Default `true`. */
  readonly driving?: boolean;
}

/**
 * Sketch constraint builders. Arguments are entity ids of the sketch: a curve id (`"l"`), a
 * point (`"p"`), or a curve's derived point: `"l.start"`, `"l.end"`, `"a.center"`,
 * `"outline.c_br.start"`. Curve ends that coincide are welded automatically (no `coincident`
 * needed). A sketch with constraints stores literal geometry only (the last solution); bind
 * dimensions to parameters through their values.
 *
 * @example
 * const base = sketch(XY, {
 *   bottom: line([-40, -25], [40, -25]),
 *   right: line([40, -25], [40, 25]),
 *   top: line([40, 25], [-40, 25]),
 *   left: line([-40, 25], [-40, -25]),
 * }, {
 *   constraints: {
 *     h1: C.horizontal("bottom"), v1: C.vertical("left"),
 *     w: C.distance("bottom.start", "bottom.end", width),
 *   },
 * });
 */
export declare const C: {
  /** Two points coincide. */
  coincident(a: string, b: string): Constraint;
  /** A line is horizontal (along the sketch's u axis). */
  horizontal(line: string): Constraint;
  /** A line is vertical (along the sketch's v axis). */
  vertical(line: string): Constraint;
  /** Two lines are parallel. */
  parallel(a: string, b: string): Constraint;
  /** Two lines are perpendicular. */
  perpendicular(a: string, b: string): Constraint;
  /** Tangency: line–circle/arc or circle/arc–circle/arc (`internal` for inside tangency). */
  tangent(a: string, b: string, options?: { readonly internal?: boolean }): Constraint;
  /** Equal length (two lines) or equal radius (two circles/arcs). */
  equal(a: string, b: string): Constraint;
  /** Distance (mm) from point `a` to point or line `b`. */
  distance(a: string, b: string, value: Scalar, options?: DimensionOptions): Constraint;
  distance(a: string, b: string, options?: DimensionOptions): Constraint;
  /** Angle (degrees) counter-clockwise from line `a` to line `b`. */
  angle(a: string, b: string, value: Scalar, options?: DimensionOptions): Constraint;
  angle(a: string, b: string, options?: DimensionOptions): Constraint;
  /** Radius (mm) of a circle or arc. */
  radius(curve: string, value: Scalar, options?: DimensionOptions): Constraint;
  radius(curve: string, options?: DimensionOptions): Constraint;
  /** Diameter (mm) of a circle or arc. */
  diameter(curve: string, value: Scalar, options?: DimensionOptions): Constraint;
  diameter(curve: string, options?: DimensionOptions): Constraint;
  /** A point lies on the (infinite) line through `line`. */
  pointOnLine(point: string, line: string): Constraint;
  /** A point lies on a circle (or an arc's full circle). */
  pointOnCircle(point: string, curve: string): Constraint;
  /** A point is the midpoint of a line. */
  midpoint(point: string, line: string): Constraint;
  /** Points `a` and `b` are mirror images about `line`. */
  symmetric(a: string, b: string, line: string): Constraint;
  /** Pin an entity where it is (a point optionally at `x`/`y`, mm). */
  fix(entity: string, at?: { readonly x?: Scalar; readonly y?: Scalar }): Constraint;
};

/** Options of {@link sketch}. */
export interface SketchOptions extends FeatureOptions {
  /** Constraints by id (the key). Makes the sketch **constrained**: literal geometry, no compound curves. */
  readonly constraints?: { readonly [id: string]: Constraint };
}

/**
 * A 2D sketch on a plane. Curves are keyed by id (the object key): ids are what queries,
 * constraints and regions name (`slab.side("bottom")`). Closed loops of the non-construction
 * curves become the regions that {@link extrude} and {@link revolve} sweep.
 *
 * @param plane XY/XZ/YZ, a frame, a planar face (`slab.cap("end")`) or a datum plane.
 * @example
 * const base = sketch(XY, { outline: rect({ center: [0, 0], w: 80, h: 50, r: 4 }) });
 * const bossSk = sketch(slab.cap("end"), { ring: circle({ center: [0, 0], radius: 11 }) });
 */
export declare function sketch(plane: PlaneRef, curves: { readonly [id: string]: Curve }, options?: SketchOptions): Sketch;

// ─── Sweeps and booleans ─────────────────────────────────────────────────────────────────────

/** How a sweep lies: `"normal"` (default), `"reverse"`, or `"symmetric"` (half each side). */
export type SweepDirection = "normal" | "reverse" | "symmetric";
/**
 * What a sweep does with its tool bodies: `"new_body"` (default), or a boolean with
 * explicit `targets`: `"join"` (union), `"cut"` (subtract), `"intersect"`.
 */
export type BodyOp = "new_body" | "join" | "cut" | "intersect";
/** Which regions of the sketch: `"all"` (default) or the curve ids whose region's outer loop contains them. */
export type Regions = "all" | readonly string[];

/** Options of {@link extrude}. */
export interface ExtrudeOptions extends FeatureOptions {
  /** Sweep length, mm, > 1e-6 (`INVALID_DISTANCE`). */
  readonly distance: Scalar;
  readonly direction?: SweepDirection;
  readonly regions?: Regions;
  readonly op?: BodyOp;
  /** Required with `op` join/cut/intersect: `"all"`, a body query or a feature handle. */
  readonly targets?: Targets;
}

/**
 * Sweep a sketch's regions along its plane normal. Faces are named after their origin:
 * `cap("start" | "end")`, `side(curve)`, edges `edgeAt(curve, end)`.
 * @example
 * const slab = extrude(base, { distance: thick });
 * const boss = extrude(bossSk, { distance: 12, op: "join", targets: slab });
 * const pocket = extrude(pocketSk, { distance: 3, direction: "reverse", op: "cut", targets: "all" });
 */
export declare function extrude(sketch: Sketch, options: ExtrudeOptions): Extrude;

/** Options of {@link revolve}. */
export interface RevolveOptions extends FeatureOptions {
  /** The axis in **sketch** coordinates: a point and a non-zero direction `[du, dv]`. */
  readonly axis: { readonly origin: Vec2; readonly direction: Vec2 };
  /** Sweep angle in degrees, in (0, 360]. */
  readonly angle: Scalar;
  readonly direction?: SweepDirection;
  readonly regions?: Regions;
  readonly op?: BodyOp;
  readonly targets?: Targets;
}

/**
 * Revolve a sketch's regions about an axis in the sketch plane.
 * @example const knob = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
 */
export declare function revolve(sketch: Sketch, options: RevolveOptions): Revolve;

/**
 * A boolean between existing bodies: `"join"`, `"cut"` or `"intersect"` `targets` with `tools`.
 * Tools are consumed unless `keepTools`.
 * @example const merged = boolean("join", { targets: floor, tools: walls });
 */
export declare function boolean(
  op: "join" | "cut" | "intersect",
  options: FeatureOptions & { readonly targets: BodyTargets; readonly tools: BodyTargets; readonly keepTools?: BoolScalar },
): Modifier;

// ─── Holes ───────────────────────────────────────────────────────────────────────────────────

/** Standard metric sizes (ISO 273 clearances, ISO 2306 tap drills; SPEC-v1 §6.5). */
export type HoleSize = "M2" | "M2.5" | "M3" | "M4" | "M5" | "M6" | "M8";
/** Which diameter a sized hole uses: ISO 273 `close`/`normal` (default)/`loose` clearance, or the `tap` drill. */
export type HoleFit = "close" | "normal" | "loose" | "tap";

/** Where holes go: {@link grid}, {@link boltCircle}, `sketch.points(…)` or `{ id: [u, v], … }`. */
export interface HolePlacement {
  readonly [brand]: "placement";
}

/**
 * Hole positions in a centred grid (in the hole plane's (u, v) frame): ids `g<i>_<j>` at
 * `center + ((i − (nx−1)/2)·dx, (j − (ny−1)/2)·dy)`.
 * @example at: grid({ nx: 2, ny: 2, dx: width - 12, dy: depth - 12 })
 */
export declare function grid(spec: {
  /** Columns (count ≥ 1). */
  readonly nx: Scalar;
  /** Rows (count ≥ 1). */
  readonly ny: Scalar;
  /** Column spacing, mm. */
  readonly dx: Scalar;
  /** Row spacing, mm. */
  readonly dy: Scalar;
  /** Grid centre, mm (default `[0, 0]`). */
  readonly center?: Vec2;
}): HolePlacement;

/**
 * Hole positions on a bolt circle: ids `c<k>` at `center + (d/2)·(cos θk, sin θk)`,
 * `θk = start + 360·k/n` degrees.
 * @example at: boltCircle({ n: 4, d: 50 })
 */
export declare function boltCircle(spec: {
  /** Number of holes (count ≥ 1). */
  readonly n: Scalar;
  /** Bolt-circle **diameter**, mm. */
  readonly d: Scalar;
  /** Centre, mm (default `[0, 0]`). */
  readonly center?: Vec2;
  /** Angle of hole `c0`, degrees (default 0). */
  readonly start?: Scalar;
}): HolePlacement;

/** Options of {@link hole}. */
export interface HoleOptions extends FeatureOptions {
  /**
   * Positions: {@link grid}, {@link boltCircle}, `sketch.points(…)`, or an object of `(u, v)`
   * positions keyed by position id: `{ a: [15.5, 15.5], b: [-15.5, 15.5] }`.
   */
  readonly at: HolePlacement | { readonly [id: string]: Vec2 };
  /** A standard size; the diameter comes from the table and `fit`. One of `size` and `d` is required. */
  readonly size?: HoleSize;
  readonly fit?: HoleFit;
  /** Explicit diameter, mm (overrides the table). */
  readonly d?: Scalar;
  /**
   * `"through"` (every target), `{ blind: depth }` (mm, to the shoulder), or `{ upTo: face }`.
   * Required, except with `insert` (whose preset sets a blind depth).
   */
  readonly depth?: "through" | { readonly blind: Scalar } | { readonly upTo: FaceSel };
  /** Drill-point angle of a blind hole, degrees (default 118), or `"flat"`. */
  readonly tip?: Scalar | "flat";
  /** Counterbore: `"iso4762"` (socket head cap screws, needs `size`) or `{ d, depth }` (mm). */
  readonly cbore?: "iso4762" | { readonly d: Scalar; readonly depth: Scalar };
  /** Countersink: `"iso10642"` (90° flat heads, needs `size`) or `{ d, angle? }` (mm, degrees; default 90). */
  readonly csink?: "iso10642" | { readonly d: Scalar; readonly angle?: Scalar };
  /** Heat-set insert hole: `"std"` (common tapered brass insert, needs `size`) or `{ d, depth }` (mm). */
  readonly insert?: "std" | { readonly d: Scalar; readonly depth: Scalar };
  /** Cosmetic thread (no geometry change): `true` (coarse pitch, tap drill) or `{ pitch?, depth? }` (mm). */
  readonly thread?: boolean | { readonly pitch?: Scalar; readonly depth?: Scalar };
  /** Reverse the drilling direction (default: into the material under the face). */
  readonly flip?: BoolScalar;
  /** Bodies to drill (default: the body owning the `on` face); required when `on` is not a face. */
  readonly targets?: Targets;
}

/**
 * Standard holes on a plane (usually a face): simple, counterbored, countersunk, heat-set
 * insert or tapped, at one or many positions; all positions form one cut.
 * @example
 * const mounts = hole(slab.cap("end"), { at: grid({ nx: 2, ny: 2, dx: 68, dy: 38 }), size: "M5", depth: "through", cbore: "iso4762" });
 * const bolts  = hole(flange.cap("end"), { at: boltCircle({ n: 4, d: 50 }), size: "M4", fit: "close", depth: "through" });
 * const pilots = hole(plate.cap("end"), { at: { a: [15.5, 15.5], b: [-15.5, 15.5] }, d: 3.4, depth: { blind: 6 } });
 */
export declare function hole(on: PlaneRef, options: HoleOptions): Hole;

// ─── Blends and offsets ──────────────────────────────────────────────────────────────────────

/**
 * Round edges with radius `r` (mm). Tangent-continuous edges are added automatically unless
 * `tangentChain: false`. If `r` is too large the feature fails with `FILLET_RADIUS_TOO_LARGE`
 * and the largest feasible radius.
 * @example const corners = fillet(slab.sides().edges().parallel(Z), { r: 4 });
 */
export declare function fillet(edges: EdgeSel, options: FeatureOptions & { readonly r: Scalar; readonly tangentChain?: BoolScalar }): Modifier;

/**
 * Bevel edges: `{ d }` (equal distances), `{ d, d2, side }` or `{ d, angle, side }` (`d`
 * measured on face `side`; `angle` in (0, 90) degrees).
 * @example const topEdge = chamfer(knob.cap("end").edges(), { d: 2 });
 */
export declare function chamfer(
  edges: EdgeSel,
  options: FeatureOptions & {
    readonly d: Scalar;
    readonly d2?: Scalar;
    readonly angle?: Scalar;
    readonly side?: FaceSel;
    readonly tangentChain?: BoolScalar;
  },
): Modifier;

/**
 * Hollow a body to wall `thickness` (mm), removing the `open` faces.
 * @example const hollow = shell(box, { open: box.cap("end"), thickness: 2 });
 */
export declare function shell(
  body: BodyTargets,
  options: FeatureOptions & { readonly thickness: Scalar; readonly open?: FaceSel; readonly direction?: "inward" | "outward" },
): Modifier;

/**
 * Taper planar faces by `angle` degrees (0 < angle < 45) about the `neutral` plane (optional in
 * v1: engines without draft reject it with `UNSUPPORTED_FEATURE`).
 * @example const tapered = draft(cup.sides(), { neutral: XY, angle: 2 });
 */
export declare function draft(
  faces: FaceSel,
  options: FeatureOptions & { readonly neutral: PlaneRef; readonly angle: Scalar; readonly pull?: "normal" | "reverse" },
): Modifier;

// ─── Patterns ────────────────────────────────────────────────────────────────────────────────

/**
 * What a pattern copies: an array of earlier `extrude`, `revolve` or `hole` features (each
 * re-applies its own operation), or bodies (a body query or a feature handle).
 */
export type PatternSeed = readonly (Extrude | Revolve | Hole)[] | BodyTargets;

/** Options every pattern accepts. */
export interface PatternOptions extends FeatureOptions {
  /** Instance indices not created: `[[3]]`, or `[[i, j]]` for two-direction linear patterns. */
  readonly skip?: readonly (readonly number[])[];
  /** Body seeds only: `"new_body"` (default) or `"join"` with `targets`. */
  readonly op?: "new_body" | "join";
  readonly targets?: Targets;
}

/**
 * Copies along one or two directions: instance `(i, j)` is moved by `i·spacing·dir + j·spacing2·dir2`.
 * @example const bossRow = linearPattern([boss, inserts], { dir: X, count: holes, spacing: 20 });
 */
export declare function linearPattern(
  seed: PatternSeed,
  options: PatternOptions & {
    readonly dir: Dir;
    /** Instances along `dir`, including the seed (count ≥ 1). */
    readonly count: Scalar;
    /** mm, may be negative. */
    readonly spacing: Scalar;
    readonly dir2?: Dir;
    readonly count2?: Scalar;
    readonly spacing2?: Scalar;
  },
): Pattern;

/**
 * Copies rotated about an axis: `count` instances (including the seed) over `angle` degrees
 * (default 360: evenly spaced).
 * @example const slots = circularPattern([slotCut], { axis: Z, count: 6 });
 */
export declare function circularPattern(
  seed: PatternSeed,
  options: PatternOptions & { readonly axis: AxisRef; readonly count: Scalar; readonly angle?: Scalar },
): Pattern;

/**
 * One mirrored copy (instance 1) in a plane.
 * @example const otherArm = mirror([arm], { plane: YZ });
 */
export declare function mirror(seed: PatternSeed, options: PatternOptions & { readonly plane: PlaneRef }): Pattern;

// ─── Datums and tags ─────────────────────────────────────────────────────────────────────────

/**
 * Options of {@link datumPlane}: exactly one form.
 * - `{ offset: plane, distance }` — `plane` moved `distance` mm along its normal;
 * - `{ from: plane, axis, angle }` — rotated `angle` degrees about an axis lying in it;
 * - `{ midplane: [a, b] }` — halfway between two parallel planes;
 * - `{ through: [p0, p1, p2] }` — through three points (origin p0, x toward p1);
 * - `{ origin, normal, xDir }` — an explicit frame.
 */
export interface DatumPlaneOptions extends FeatureOptions {
  readonly offset?: PlaneRef;
  readonly from?: PlaneRef;
  /** Offset distance, mm (any sign). */
  readonly distance?: Scalar;
  readonly axis?: AxisRef;
  /** Rotation, degrees (right-hand rule about the axis). */
  readonly angle?: Scalar;
  readonly midplane?: readonly [PlaneRef, PlaneRef];
  readonly through?: readonly [PointRef, PointRef, PointRef];
  readonly origin?: Vec3;
  readonly normal?: Vec3;
  readonly xDir?: Vec3;
  /** Only to spell out a form the keys do not imply. */
  readonly mode?: "offset" | "angle" | "midplane" | "through" | "frame";
}

/**
 * A construction plane (no body), usable wherever a plane is.
 * @example
 * const mid = datumPlane({ midplane: [slab.side("outline.left"), slab.side("outline.right")] });
 * const tilted = datumPlane({ from: XY, axis: X, angle: 30 });
 * const above = datumPlane({ offset: slab.cap("end"), distance: 10 });
 */
export declare function datumPlane(options: DatumPlaneOptions): DatumPlane;

/**
 * Options of {@link datumAxis}: exactly one form — `{ edge }`, `{ cylinder }`,
 * `{ planes: [a, b] }` (their intersection) or `{ points: [a, b] }`; `flip` reverses it.
 */
export interface DatumAxisOptions extends FeatureOptions {
  readonly edge?: EdgeSel;
  readonly cylinder?: FaceSel;
  readonly planes?: readonly [PlaneRef, PlaneRef];
  readonly points?: readonly [PointRef, PointRef];
  readonly flip?: BoolScalar;
  /** Only to spell out a form the keys do not imply. */
  readonly mode?: "edge" | "cylinder" | "planes" | "points";
}

/**
 * A construction axis (no body), usable wherever an axis or direction is.
 * @example
 * const bossAxis = datumAxis({ cylinder: boss.side("ring") });
 * const hinge = datumAxis({ planes: [XZ, mid] });
 */
export declare function datumAxis(options: DatumAxisOptions): DatumAxis;

/**
 * A stable, named handle for a selection, resolved where the tag is (so a broken reference shows
 * up there) and re-evaluated wherever the handle is used.
 * @example
 * const mountFace = tag(slab.body().faces().normal("-Z").one());
 * const inserts = hole(mountFace, { at: { a: [10, 10], b: [-10, 10] }, size: "M3", insert: "std" });
 */
export declare function tag(target: FaceSel, options?: FeatureOptions): Faces;
export declare function tag(target: EdgeSel, options?: FeatureOptions): Edges;
export declare function tag(target: VertexSel, options?: FeatureOptions): Vertices;
export declare function tag(target: BodySel, options?: FeatureOptions): Bodies;

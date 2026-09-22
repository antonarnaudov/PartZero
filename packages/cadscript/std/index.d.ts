/**
 * # `@aicad/std` — the CadScript v0 standard library
 *
 * CadScript is a statically compiled subset of TypeScript. A `.cad.ts` file is **parsed and
 * compiled** to the Feature-Graph IR (`aicad.ir/0`); it is **never executed**. These declarations
 * exist so that editors, `tsc` and agents get types, completions and documentation.
 *
 * One file is one IR document:
 *
 * ```ts
 * import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";
 *
 * doc({ name: "extrude_box", description: "80x50 rectangle extruded 8 mm" });
 *
 * part("part");
 * const base = sketch(XY, {
 *   bottom: line([-40, -25], [40, -25]),
 *   right: line([40, -25], [40, 25]),
 *   top: line([40, 25], [-40, 25]),
 *   left: line([-40, 25], [-40, -25]),
 * });
 * const plate = extrude(base, { distance: 8 });
 * ```
 *
 * ## Rules of CadScript v0
 * - **Units are fixed:** lengths in millimetres (mm), angles in degrees (°).
 * - **Tolerance:** points closer than `1e-6` mm coincide; lengths at or below `1e-6` mm are degenerate.
 * - **Statements:** `import { … } from "@aicad/std"`, then optionally one `doc({ … })`, then
 *   `part("name")` followed by that part's features. Several parts are allowed.
 * - **Features** are top-level `const name = sketch(…) | extrude(…) | revolve(…)`. The const name
 *   *is* the feature name: an identifier matching `[A-Za-z_][A-Za-z0-9_]*`, unique in the file.
 *   Features run in file order and may only use sketches declared above them in the same part.
 * - **Arguments are literals:** numbers (optionally negative, e.g. `-2.5`), `[…]` arrays,
 *   `{ … }` objects, `true`/`false` and `"strings"` where a string is expected. The only
 *   identifiers allowed are the plane constants (`XY`, `XZ`, `YZ`) and sketch consts passed to
 *   `extrude`/`revolve`; the only nested calls are `line`, `arc`, `circle` and `frame`.
 * - **Not in v0:** arithmetic, variables/`param()`, `let`/`var`, loops, `if`, functions,
 *   template strings and spreads. Expressions and `param()` arrive in CadScript v1.
 *
 * @packageDocumentation
 */

declare const kind: unique symbol;

// ─── Values ──────────────────────────────────────────────────────────────────────────────────

/**
 * A 2D point or vector in **sketch coordinates** `[u, v]`, in **mm**.
 *
 * `u` runs along the sketch plane's x axis and `v` along its y axis; see {@link XY}, {@link XZ},
 * {@link YZ} and {@link frame} for how each plane maps `(u, v)` into 3D.
 */
export type Vec2 = readonly [u: number, v: number];

/** A 3D point or vector in **model coordinates** `[x, y, z]`, in **mm**. */
export type Vec3 = readonly [x: number, y: number, z: number];

/**
 * How a sweep is placed relative to the sketch plane (extrude) or the axis (revolve):
 * - `"normal"` (default): along +normal / positive rotation (right-hand rule about the axis).
 * - `"reverse"`: along −normal / negative rotation.
 * - `"symmetric"`: half of the distance or angle on each side of the sketch plane.
 */
export type SweepDirection = "normal" | "reverse" | "symmetric";

// ─── Planes ──────────────────────────────────────────────────────────────────────────────────

/** A sketch plane: {@link XY}, {@link XZ}, {@link YZ} or an explicit {@link frame}. */
export interface Plane {
  readonly [kind]: "plane";
}

/**
 * The XY datum plane: x axis = +X, y axis = +Y, **normal = +Z**.
 * A sketch point `[u, v]` lies at 3D `(u, v, 0)`.
 */
export declare const XY: Plane;

/**
 * The XZ datum plane: x axis = +X, y axis = +Z, **normal = −Y** (right-handed: x × y = normal).
 * A sketch point `[u, v]` lies at 3D `(u, 0, v)`; `extrude` with direction `"normal"` goes toward −Y.
 */
export declare const XZ: Plane;

/**
 * The YZ datum plane: x axis = +Y, y axis = +Z, **normal = +X**.
 * A sketch point `[u, v]` lies at 3D `(0, u, v)`.
 */
export declare const YZ: Plane;

/** Arguments of {@link frame}. */
export interface FrameSpec {
  /** Plane origin in model coordinates, mm. Sketch point `[0, 0]` maps here. */
  readonly origin: Vec3;
  /** Plane normal (extrude direction for `"normal"`). Any non-zero length; it is normalised. */
  readonly normal: Vec3;
  /**
   * Direction of the sketch's u axis. Any non-zero length; must be perpendicular to `normal`
   * (|cos| ≤ 1e-9). The v axis is `normal × xDir`.
   */
  readonly xDir: Vec3;
}

/**
 * An explicit, right-handed sketch plane. A sketch point `[u, v]` maps to
 * `origin + u·x + v·y` where `x = normalize(xDir)` and `y = normalize(normal) × x`.
 *
 * @example
 * // A plane 10 mm above XY, with the same orientation as XY:
 * const lid = sketch(frame({ origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
 *   rim: circle({ center: [0, 0], radius: 20 }),
 * });
 */
export declare function frame(spec: FrameSpec): Plane;

// ─── Sketch curves ───────────────────────────────────────────────────────────────────────────

/** A straight segment created by {@link line}. */
export interface Line {
  readonly [kind]: "line";
}
/** A circular arc created by {@link arc}. */
export interface Arc {
  readonly [kind]: "arc";
}
/** A full circle created by {@link circle}. */
export interface Circle {
  readonly [kind]: "circle";
}
/** Any sketch curve. */
export type Curve = Line | Arc | Circle;

/**
 * A straight line segment from `start` to `end` (sketch coordinates, mm).
 * Its length must be greater than 1e-6 mm.
 *
 * @param start First endpoint `[u, v]`, mm.
 * @param end Second endpoint `[u, v]`, mm.
 * @example
 * bottom: line([-40, -25], [40, -25]),
 */
export declare function line(start: Vec2, end: Vec2): Line;

/** Arguments of {@link arc}. */
export interface ArcSpec {
  /** Start point `[u, v]`, mm. The radius is `|start − center|`. */
  readonly start: Vec2;
  /** End point `[u, v]`, mm. `|end − center|` must equal the radius within 1e-6 mm, and `end ≠ start`. */
  readonly end: Vec2;
  /** Centre `[u, v]`, mm. */
  readonly center: Vec2;
  /**
   * `true`: the arc runs counter-clockwise from `start` to `end`; `false`: clockwise — as seen
   * looking against the plane normal (the standard orientation of the (u, v) plane).
   * The sweep is strictly between 0° and 360°; use {@link circle} for a full turn.
   */
  readonly ccw: boolean;
}

/**
 * A circular arc from `start` to `end` around `center`.
 *
 * @example
 * // Right half of an obround slot, counter-clockwise from bottom to top:
 * right_cap: arc({ start: [20, -6], end: [20, 6], center: [20, 0], ccw: true }),
 */
export declare function arc(spec: ArcSpec): Arc;

/** Arguments of {@link circle}. */
export interface CircleSpec {
  /** Centre `[u, v]`, mm. */
  readonly center: Vec2;
  /** Radius, mm. Must be greater than 1e-6. (Radius, not diameter: an M5 clearance hole is `2.75`.) */
  readonly radius: number;
}

/**
 * A full circle. A circle is a closed loop on its own.
 *
 * @example
 * hole: circle({ center: [10, 10], radius: 2.75 }),
 */
export declare function circle(spec: CircleSpec): Circle;

// ─── Features ────────────────────────────────────────────────────────────────────────────────

/** A sketch feature, created by {@link sketch}. Pass it to {@link extrude} or {@link revolve}. */
export interface Sketch {
  readonly [kind]: "sketch";
}
/** An extrude feature, created by {@link extrude}. */
export interface Extrude {
  readonly [kind]: "extrude";
}
/** A revolve feature, created by {@link revolve}. */
export interface Revolve {
  readonly [kind]: "revolve";
}

/**
 * The curves of a sketch, keyed by **curve id**. Ids are unique within the sketch and are the
 * stable names of the faces and edges each curve generates (keep them meaningful, e.g. `top`,
 * `left_cap`, `h1`). Use a quoted key for ids that are not identifiers: `"hole-1": circle(…)`.
 */
export interface SketchCurves {
  readonly [id: string]: Curve;
}

/** Options of {@link sketch}. */
export interface SketchOptions {
  /** Skip this feature when evaluating; features that use it then fail with `SKETCH_SUPPRESSED`. @default false */
  readonly suppressed?: boolean;
}

/**
 * A 2D sketch on a plane. It produces **regions**, not bodies.
 *
 * - Lines and arcs must join end-to-end into **closed loops** (endpoints coincide within 1e-6 mm,
 *   each endpoint shared by exactly two curve ends); a circle is a loop by itself.
 * - Curves may only meet at shared endpoints: no crossings or touching (no automatic splitting).
 * - Loops nest: a loop inside another becomes a **hole**; a loop inside a hole is a new region.
 *   Disjoint loops give several regions, and extruding/revolving them gives one body per region.
 *
 * @param plane {@link XY}, {@link XZ}, {@link YZ} or `frame({ … })`.
 * @param curves The curves, keyed by curve id (see {@link SketchCurves}).
 * @param options `{ suppressed: true }` to suppress the feature.
 * @example
 * const base = sketch(XY, {
 *   bottom: line([0, 0], [100, 0]),
 *   right: line([100, 0], [100, 60]),
 *   top: line([100, 60], [0, 60]),
 *   left: line([0, 60], [0, 0]),
 *   h1: circle({ center: [10, 10], radius: 2.75 }),
 * });
 */
export declare function sketch(plane: Plane, curves: SketchCurves, options?: SketchOptions): Sketch;

/** Options of {@link extrude}. */
export interface ExtrudeOptions {
  /**
   * Total extrusion distance, **mm**; must be greater than 1e-6. With `direction: "symmetric"`
   * half of it goes to each side of the sketch plane. To extrude the other way use
   * `direction: "reverse"`, not a negative distance.
   */
  readonly distance: number;
  /** Which side of the sketch plane the extrusion goes to. @default "normal" */
  readonly direction?: SweepDirection;
  /** Skip this feature when evaluating. @default false */
  readonly suppressed?: boolean;
}

/**
 * Extrude every region of a sketch along the sketch plane's normal. Each region becomes one new
 * solid body.
 *
 * - `"normal"`: from the plane to `+distance·n`; `"reverse"`: to `−distance·n`;
 *   `"symmetric"`: from `−distance/2·n` to `+distance/2·n`.
 *
 * @param sketch A sketch const declared earlier in the same part.
 * @example
 * const plate = extrude(base, { distance: 8 });
 * const bar = extrude(slot, { distance: 10, direction: "symmetric" });
 */
export declare function extrude(sketch: Sketch, options: ExtrudeOptions): Extrude;

/** A revolution axis in the sketch's own 2D coordinates. */
export interface AxisSpec {
  /** A point on the axis `[u, v]`, mm. */
  readonly origin: Vec2;
  /** Axis direction `[u, v]`; any non-zero length. The rotation follows the right-hand rule about it. */
  readonly direction: Vec2;
}

/** Options of {@link revolve}. */
export interface RevolveOptions {
  /** The axis, in sketch coordinates. E.g. the sketch's v axis: `{ origin: [0, 0], direction: [0, 1] }`. */
  readonly axis: AxisSpec;
  /** Total sweep angle in **degrees**, `0 < angle ≤ 360`. `360` gives a closed body with no end caps. */
  readonly angle: number;
  /** `"normal"`: +angle (right-hand rule); `"reverse"`: −angle; `"symmetric"`: ±angle/2. @default "normal" */
  readonly direction?: SweepDirection;
  /** Skip this feature when evaluating. @default false */
  readonly suppressed?: boolean;
}

/**
 * Revolve every region of a sketch about an axis lying in the sketch plane. Each region becomes
 * one new solid body.
 *
 * - Every region must lie on one side of the axis line (touching the axis is fine; crossing it
 *   fails with `REVOLVE_CROSSES_AXIS`). Profile edges lying on the axis create no faces.
 * - With `angle: 360` the body is closed; below 360 it gets two planar end caps.
 *
 * @param sketch A sketch const declared earlier in the same part.
 * @example
 * // A solid cylinder r = 10, h = 30 from a rectangle touching the v axis on XZ:
 * const rod = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
 */
export declare function revolve(sketch: Sketch, options: RevolveOptions): Revolve;

// ─── Document structure ──────────────────────────────────────────────────────────────────────

/** Arguments of {@link doc}. */
export interface DocMeta {
  /** Document name (e.g. a file stem such as `"bracket_v2"`). */
  readonly name?: string;
  /** One-line human description of the design intent. */
  readonly description?: string;
}

/**
 * Document metadata. Optional; if present it must be the first statement after the imports and
 * appear once. Units are implicit in v0 (mm, degrees).
 *
 * @example
 * doc({ name: "extrude_box", description: "80x50 rectangle extruded 8 mm" });
 */
export declare function doc(meta: DocMeta): void;

/**
 * Start a part studio: an ordered feature timeline that produces a set of bodies. Every feature
 * const after this call (until the next `part`) belongs to it. A file needs at least one part;
 * part names must be unique.
 *
 * @param name The part studio's name, e.g. `"part"` or `"lid"`.
 * @example
 * part("part");
 * const base = sketch(XY, { c: circle({ center: [0, 0], radius: 5 }) });
 */
export declare function part(name: string): void;

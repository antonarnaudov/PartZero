/** Lexical facts about CadScript v1 (`@aicad/std` v1, SPEC-v1 §2.9, §5.10, §9.3). */
import { v1 } from "@aicad/ir-types";
import { BUILTINS as V0_BUILTINS, RESERVED_WORDS } from "../syntax.js";

/**
 * Every export of `@aicad/std` v1, in canonical import order: the v0 builtins, then the v1
 * builtins in the order of `RESERVED_NAMES_V1_BUILTINS` (`ir-v1.constants.json`).
 */
export const BUILTINS_V1: readonly string[] = [...V0_BUILTINS, ...v1.RESERVED_NAMES_V1_BUILTINS];
export const BUILTIN_SET: ReadonlySet<string> = new Set(BUILTINS_V1);

/**
 * forge-ir's full v1 `RESERVED_NAMES` (reserved words, v0 builtins, v1 builtins): what a
 * parameter may not be named. A test keeps it equal to `ir-v1.constants.json`.
 */
export const RESERVED_NAMES_V1: ReadonlySet<string> = new Set([...RESERVED_WORDS, ...BUILTINS_V1]);

/** Names a feature may not have even in migrated v0 documents (`RESERVED_NAMES_V0`). */
export const RESERVED_NAMES_V0: ReadonlySet<string> = new Set([...RESERVED_WORDS, ...V0_BUILTINS]);

export function isBuiltinV1(name: string): boolean {
  return BUILTIN_SET.has(name);
}

/** Feature builtins → the IR feature `type` they create. */
export const FEATURE_BUILTINS: Readonly<Record<string, string>> = {
  sketch: "sketch",
  extrude: "extrude",
  revolve: "revolve",
  boolean: "boolean",
  hole: "hole",
  fillet: "fillet",
  chamfer: "chamfer",
  shell: "shell",
  draft: "draft",
  linearPattern: "pattern",
  circularPattern: "pattern",
  mirror: "pattern",
  datumPlane: "datum_plane",
  datumAxis: "datum_axis",
  tag: "tag",
  thread: "thread",
};

export function isFeatureBuiltin(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FEATURE_BUILTINS, name);
}

export const CURVE_BUILTINS: readonly string[] = ["line", "arc", "circle", "point", "rect", "slot", "polygon"];
export const PLANE_CONSTANTS: readonly string[] = ["XY", "XZ", "YZ"];
export const AXIS_CONSTANTS: readonly string[] = ["X", "Y", "Z"];
export const UNIT_BUILTINS: Readonly<Record<string, "mm" | "cm" | "in" | "deg">> = { mm: "mm", cm: "cm", inch: "in", deg: "deg" };
export const MATH_BUILTINS: readonly string[] = ["min", "max", "abs", "sqrt", "floor", "ceil", "round", "clamp", "hypot", "sin", "cos", "tan", "asin", "acos", "atan", "atan2"];
export const QUERY_FUNCTIONS: readonly string[] = ["edgesBetween", "faceOf", "body", "bodies"];
export const SIGNED_DIRS: readonly string[] = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];

/** Handle methods that start a query, by feature type. */
export const HANDLE_METHODS: Readonly<Record<string, readonly string[]>> = {
  extrude: ["cap", "side", "sides", "edgeAt", "body", "faces"],
  revolve: ["endcap", "side", "sides", "edgeAt", "body", "faces"],
  hole: ["wall", "tip", "floor", "cboreWall", "cboreFloor", "csink", "faces"],
  pattern: ["instance", "body", "faces"],
  boolean: ["faces"],
  fillet: ["faces"],
  chamfer: ["faces"],
  shell: ["faces"],
  draft: ["faces"],
  thread: ["faces"],
  sketch: ["points"],
  datum_plane: [],
  datum_axis: [],
};

/** Every method a feature handle has in some feature type (others are `CS_UNKNOWN_METHOD`). */
export const ALL_HANDLE_METHODS: ReadonlySet<string> = new Set(Object.values(HANDLE_METHODS).flat());

/** Hole face methods → `hole_face.part`. */
export const HOLE_PARTS: Readonly<Record<string, string>> = {
  wall: "wall",
  tip: "tip",
  floor: "floor",
  cboreWall: "cbore_wall",
  cboreFloor: "cbore_floor",
  csink: "csink",
};

/** Query methods (on a query, not a handle). */
export const QUERY_METHODS: ReadonlySet<string> = new Set([
  "faces",
  "edges",
  "vertices",
  "owner",
  "and",
  "common",
  "minus",
  "planes",
  "cylinders",
  "cones",
  "spheres",
  "tori",
  "lines",
  "circles",
  "ofType",
  "normal",
  "parallel",
  "perpendicular",
  "convex",
  "concave",
  "smooth",
  "radius",
  "max",
  "min",
  "largest",
  "smallest",
  "one",
  "some",
  "any",
  "exactly",
]);

/** Type-filter shorthands ↔ `{ type: t }`. */
export const TYPE_FILTERS: Readonly<Record<string, string>> = {
  planes: "plane",
  cylinders: "cylinder",
  cones: "cone",
  spheres: "sphere",
  tori: "torus",
  lines: "line",
  circles: "circle",
};

/** Constraint builders `C.<method>` ↔ IR constraint `type`. */
export const CONSTRAINT_METHODS: Readonly<Record<string, string>> = {
  coincident: "coincident",
  horizontal: "horizontal",
  vertical: "vertical",
  parallel: "parallel",
  perpendicular: "perpendicular",
  tangent: "tangent",
  equal: "equal",
  distance: "distance",
  angle: "angle",
  radius: "radius",
  diameter: "diameter",
  pointOnLine: "point_on_line",
  pointOnCircle: "point_on_circle",
  midpoint: "midpoint",
  symmetric: "symmetric",
  fix: "fix",
};

/** IR metadata fields ↔ CadScript option keys (common to every feature). */
export const METADATA_KEYS: readonly [ir: string, cs: string][] = [
  ["note", "note"],
  ["intent", "intent"],
  ["author", "author"],
  ["assumptions", "assumptions"],
  ["decision_ids", "decisionIds"],
];

/** Hints for snake_case IR keys written in CadScript. */
export const SNAKE_KEY_HINTS: Readonly<Record<string, string>> = {
  x_dir: "CadScript spells it `xDir`",
  keep_tools: "CadScript spells it `keepTools`",
  tangent_chain: "CadScript spells it `tangentChain`",
  across_flats: "CadScript spells it `acrossFlats`",
  up_to: "CadScript spells it `upTo`",
  decision_ids: "CadScript spells it `decisionIds`",
};

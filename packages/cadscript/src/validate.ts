/**
 * Structural validation of IR documents — a line-by-line TypeScript mirror of
 * `forge/crates/forge-ir/src/validate.rs`. Codes and paths are identical, so an error found by the
 * Rust engine and one found here are interchangeable (and map to the same CadScript span).
 *
 * Like the Rust version this does no geometry evaluation: closed loops, crossings and nesting are
 * decided by the engine at evaluation time.
 */
import { IR_SCHEMA, LINEAR_TOLERANCE, type IrDocument, type PartStudio, type SketchFeature } from "@aicad/ir-types";
import { IR_IDENTIFIER, IR_RESERVED_NAMES } from "./syntax.js";

export interface IrValidationError {
  /** Stable machine-readable code, e.g. `DUPLICATE_NAME` (same as forge-ir). */
  code: string;
  /** JSON-pointer-like path to the offending element, e.g. `/parts/0/features/1/distance`. */
  path: string;
  message: string;
}

/** Rust `{:?}` formatting of a string, closely enough for messages. */
const dbg = (s: string): string => JSON.stringify(s);

/** Validate a document. Returns every problem found (not just the first); empty when valid. */
export function validateIr(doc: IrDocument): IrValidationError[] {
  const errs: IrValidationError[] = [];
  const err = (code: string, path: string, message: string): void => {
    errs.push({ code, path, message });
  };
  if (doc.schema !== IR_SCHEMA) {
    err("UNSUPPORTED_SCHEMA", "/schema", `expected ${dbg(IR_SCHEMA)}, got ${dbg(doc.schema)}`);
  }
  if (doc.parts.length === 0) err("NO_PARTS", "/parts", "a document needs at least one part studio");
  const partIds = new Set<string>();
  const partNames = new Set<string>();
  // Feature ids and names are unique across the WHOLE document (forge-ir SPEC §0).
  const featureIds = new Set<string>();
  const featureNames = new Set<string>();
  doc.parts.forEach((part, pi) => {
    const pp = `/parts/${pi}`;
    if (partIds.has(part.id)) err("DUPLICATE_ID", `${pp}/id`, `part id ${dbg(part.id)}`);
    partIds.add(part.id);
    if (partNames.has(part.name)) err("DUPLICATE_NAME", `${pp}/name`, `part ${dbg(part.name)}`);
    partNames.add(part.name);
    validatePart(part, pp, featureIds, featureNames, err);
  });
  return errs;
}

type Err = (code: string, path: string, message: string) => void;

function validatePart(part: PartStudio, pp: string, ids: Set<string>, names: Set<string>, err: Err): void {
  // Names of sketch features seen so far (features may only reference earlier ones).
  const sketchesBefore = new Set<string>();
  part.features.forEach((f, fi) => {
    const fp = `${pp}/features/${fi}`;
    if (ids.has(f.id)) err("DUPLICATE_ID", `${fp}/id`, `feature id ${dbg(f.id)}`);
    ids.add(f.id);
    if (names.has(f.name)) err("DUPLICATE_NAME", `${fp}/name`, dbg(f.name));
    names.add(f.name);
    if (!IR_IDENTIFIER.test(f.name)) {
      err("INVALID_NAME", `${fp}/name`, `${dbg(f.name)} must match [A-Za-z_][A-Za-z0-9_]* (it is a CadScript const)`);
    } else if (IR_RESERVED_NAMES.has(f.name)) {
      err("RESERVED_NAME", `${fp}/name`, `${dbg(f.name)} is a reserved word or CadScript builtin; pick another name`);
    }
    switch (f.type) {
      case "sketch":
        validateSketch(f, fp, err);
        sketchesBefore.add(f.name);
        break;
      case "extrude":
        checkSketchRef(f.sketch, sketchesBefore, fp, err);
        if (!(Number.isFinite(f.distance) && f.distance > LINEAR_TOLERANCE)) {
          err("INVALID_DISTANCE", `${fp}/distance`, `must be finite and > ${LINEAR_TOLERANCE} mm, got ${f.distance}`);
        }
        break;
      case "revolve": {
        checkSketchRef(f.sketch, sketchesBefore, fp, err);
        if (!(Number.isFinite(f.angle) && f.angle > 0 && f.angle <= 360)) {
          err("INVALID_ANGLE", `${fp}/angle`, `must be in (0, 360] degrees, got ${f.angle}`);
        }
        const d = f.axis.direction;
        if (!(finite2(f.axis.origin) && finite2(d)) || Math.sqrt(d[0] * d[0] + d[1] * d[1]) <= LINEAR_TOLERANCE) {
          err("INVALID_AXIS", `${fp}/axis`, "axis origin/direction must be finite and direction non-zero");
        }
        break;
      }
    }
  });
}

function checkSketchRef(name: string, sketchesBefore: Set<string>, fp: string, err: Err): void {
  if (!sketchesBefore.has(name)) {
    err("UNRESOLVED_SKETCH", `${fp}/sketch`, `${dbg(name)} is not an earlier sketch feature in this part studio`);
  }
}

function validateSketch(s: SketchFeature, fp: string, err: Err): void {
  if (typeof s.plane !== "string") {
    const f = s.plane;
    const n = len3(f.normal);
    const x = len3(f.x_dir);
    const finite = [...f.origin, ...f.normal, ...f.x_dir].every(Number.isFinite);
    if (!finite || n <= LINEAR_TOLERANCE || x <= LINEAR_TOLERANCE) {
      err("INVALID_PLANE", `${fp}/plane`, "degenerate frame");
    } else {
      const dot = (f.normal[0] * f.x_dir[0] + f.normal[1] * f.x_dir[1] + f.normal[2] * f.x_dir[2]) / (n * x);
      if (Math.abs(dot) > 1e-9) {
        err("INVALID_PLANE", `${fp}/plane`, `normal and x_dir must be perpendicular (cos = ${dot.toExponential()})`);
      }
    }
  }
  if (s.curves.length === 0) err("EMPTY_SKETCH", `${fp}/curves`, "a sketch needs at least one curve");
  const ids = new Set<string>();
  s.curves.forEach((c, ci) => {
    const cp = `${fp}/curves/${ci}`;
    if (ids.has(c.id)) err("DUPLICATE_ID", `${cp}/id`, `curve id ${dbg(c.id)}`);
    ids.add(c.id);
    switch (c.kind) {
      case "line":
        if (!(finite2(c.start) && finite2(c.end))) err("NON_FINITE", cp, "line endpoints must be finite");
        else if (dist2(c.start, c.end) <= LINEAR_TOLERANCE) err("DEGENERATE_CURVE", cp, "zero-length line");
        break;
      case "arc": {
        if (!(finite2(c.start) && finite2(c.end) && finite2(c.center))) {
          err("NON_FINITE", cp, "arc points must be finite");
          break;
        }
        const r0 = dist2(c.start, c.center);
        const r1 = dist2(c.end, c.center);
        if (r0 <= LINEAR_TOLERANCE || r1 <= LINEAR_TOLERANCE) err("DEGENERATE_CURVE", cp, "zero-radius arc");
        else if (Math.abs(r0 - r1) > LINEAR_TOLERANCE) {
          err("INCONSISTENT_ARC", cp, `|start−center| = ${r0} but |end−center| = ${r1}`);
        } else if (dist2(c.start, c.end) <= LINEAR_TOLERANCE) {
          err("DEGENERATE_CURVE", cp, "arc start == end; use a circle for a full turn");
        }
        break;
      }
      case "circle":
        if (!(finite2(c.center) && Number.isFinite(c.radius))) {
          err("NON_FINITE", cp, "circle center and radius must be finite");
        } else if (c.radius <= LINEAR_TOLERANCE) {
          err("DEGENERATE_CURVE", cp, "circle radius must be > 0");
        }
        break;
    }
  });
}

function finite2(p: readonly [number, number]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function dist2(a: readonly [number, number], b: readonly [number, number]): number {
  // Rust's `powi(2)` is a plain multiplication; mirror it exactly.
  const du = a[0] - b[0];
  const dv = a[1] - b[1];
  return Math.sqrt(du * du + dv * dv);
}

function len3(v: readonly [number, number, number]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

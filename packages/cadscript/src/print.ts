/**
 * The canonical CadScript printer: IR → source text.
 *
 * Formatting is fully deterministic: 2-space indent, one curve per line with trailing commas,
 * numbers via JS shortest round-trip (`-0` prints as `0`), strings as JSON literals, and fields
 * equal to their IR default omitted. `compile(print(ir), { base: ir }).ir` equals `ir`.
 */
import type { Feature, IrDocument, Meta, PartStudio, PlaneSpec, SketchCurve } from "@aicad/ir-types";
import { BUILTINS, formatNumber, formatString, isBareKey, isBindableName, STD_MODULE, type Builtin } from "./syntax.js";

/** Thrown when an IR document cannot be expressed in CadScript v0 syntax at all. */
export class CadScriptPrintError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`IR cannot be printed as CadScript v0:\n  ${problems.join("\n  ")}`);
    this.name = "CadScriptPrintError";
    this.problems = problems;
  }
}

export interface PrintOptions {
  /**
   * Leading comment text to emit above feature statements, keyed by feature id — e.g. the
   * `comments` of a previous {@link CompileResult}. Each value is raw comment source (`// …`).
   */
  comments?: Readonly<Record<string, string>>;
}

/** Print a whole IR document as a CadScript file. */
export function print(ir: IrDocument, options: PrintOptions = {}): string {
  const problems = printabilityProblems(ir);
  if (problems.length > 0) throw new CadScriptPrintError(problems);
  const blocks: string[] = [printImport()];
  const docStmt = printDocStatement(ir.meta);
  if (docStmt !== undefined) blocks.push(docStmt);
  for (const part of ir.parts) {
    const lines = [printPartStatement(part)];
    for (const f of part.features) {
      const comment = options.comments && Object.prototype.hasOwnProperty.call(options.comments, f.id) ? options.comments[f.id] : undefined;
      if (comment) lines.push(comment);
      lines.push(printFeatureStatement(f));
    }
    blocks.push(lines.join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Everything that makes `ir` impossible to write as CadScript syntax (empty when printable). */
export function printabilityProblems(ir: IrDocument): string[] {
  const problems: string[] = [];
  ir.parts.forEach((part, pi) => {
    part.features.forEach((f, fi) => {
      const at = `/parts/${pi}/features/${fi}`;
      if (!isBindableName(f.name)) {
        problems.push(`${at}/name: ${formatString(f.name)} is not usable as a const name (identifier, not a reserved word)`);
      }
      if (f.type !== "sketch" && !isBindableName(f.sketch)) {
        problems.push(`${at}/sketch: ${formatString(f.sketch)} is not usable as a const reference`);
      }
      for (const n of featureNumbers(f)) {
        if (!Number.isFinite(n)) {
          problems.push(`${at}: non-finite number ${n} has no CadScript literal`);
          break;
        }
      }
    });
  });
  return problems;
}

function featureNumbers(f: Feature): number[] {
  switch (f.type) {
    case "sketch": {
      const out: number[] = typeof f.plane === "string" ? [] : [...f.plane.origin, ...f.plane.normal, ...f.plane.x_dir];
      for (const c of f.curves) {
        if (c.kind === "line") out.push(...c.start, ...c.end);
        else if (c.kind === "arc") out.push(...c.start, ...c.end, ...c.center);
        else out.push(...c.center, c.radius);
      }
      return out;
    }
    case "extrude":
      return [f.distance];
    case "revolve":
      return [...f.axis.origin, ...f.axis.direction, f.angle];
  }
}

/** The canonical import statement. The printer always imports every builtin (stable diffs). */
export function printImport(names: Iterable<string> = BUILTINS): string {
  const set = new Set(names);
  const ordered = [...BUILTINS.filter((b) => set.has(b)), ...[...set].filter((n) => !BUILTINS.includes(n as Builtin)).sort()];
  return `import { ${ordered.join(", ")} } from ${formatString(STD_MODULE)};`;
}

/** `doc({ … });`, or undefined when the metadata is empty. */
export function printDocStatement(meta: Meta | undefined): string | undefined {
  const fields: string[] = [];
  if (meta?.name) fields.push(`name: ${formatString(meta.name)}`);
  if (meta?.description) fields.push(`description: ${formatString(meta.description)}`);
  return fields.length > 0 ? `doc({ ${fields.join(", ")} });` : undefined;
}

export function printPartStatement(part: Pick<PartStudio, "name">): string {
  return `part(${formatString(part.name)});`;
}

const vec = (v: readonly number[]): string => `[${v.map(formatNumber).join(", ")}]`;

function printPlane(plane: PlaneSpec): string {
  if (typeof plane === "string") return plane;
  return `frame({ origin: ${vec(plane.origin)}, normal: ${vec(plane.normal)}, xDir: ${vec(plane.x_dir)} })`;
}

function printKey(key: string): string {
  return isBareKey(key) ? key : formatString(key);
}

/** The call expression for one sketch curve, e.g. `line([0, 0], [10, 0])`. */
export function printCurve(c: SketchCurve): string {
  switch (c.kind) {
    case "line":
      return `line(${vec(c.start)}, ${vec(c.end)})`;
    case "arc":
      return `arc({ start: ${vec(c.start)}, end: ${vec(c.end)}, center: ${vec(c.center)}, ccw: ${c.ccw} })`;
    case "circle":
      return `circle({ center: ${vec(c.center)}, radius: ${formatNumber(c.radius)} })`;
  }
}

/** One feature as a complete `const name = …;` statement (possibly multi-line, no trailing newline). */
export function printFeatureStatement(f: Feature): string {
  switch (f.type) {
    case "sketch": {
      const curves =
        f.curves.length === 0 ? "{}" : `{\n${f.curves.map((c) => `  ${printKey(c.id)}: ${printCurve(c)},`).join("\n")}\n}`;
      const opts = f.suppressed ? ", { suppressed: true }" : "";
      return `const ${f.name} = sketch(${printPlane(f.plane)}, ${curves}${opts});`;
    }
    case "extrude": {
      const fields = [`distance: ${formatNumber(f.distance)}`];
      if (f.direction !== undefined && f.direction !== "normal") fields.push(`direction: ${formatString(f.direction)}`);
      if (f.suppressed) fields.push("suppressed: true");
      return `const ${f.name} = extrude(${f.sketch}, { ${fields.join(", ")} });`;
    }
    case "revolve": {
      const fields = [`axis: { origin: ${vec(f.axis.origin)}, direction: ${vec(f.axis.direction)} }`, `angle: ${formatNumber(f.angle)}`];
      if (f.direction !== undefined && f.direction !== "normal") fields.push(`direction: ${formatString(f.direction)}`);
      if (f.suppressed) fields.push("suppressed: true");
      return `const ${f.name} = revolve(${f.sketch}, { ${fields.join(", ")} });`;
    }
  }
}

/** The builtins the canonical text of `ir` refers to. */
export function usedBuiltins(ir: IrDocument): Set<Builtin> {
  const used = new Set<Builtin>();
  if (printDocStatement(ir.meta) !== undefined) used.add("doc");
  for (const part of ir.parts) {
    used.add("part");
    for (const f of part.features) {
      used.add(f.type);
      if (f.type === "sketch") {
        used.add(typeof f.plane === "string" ? f.plane : "frame");
        for (const c of f.curves) used.add(c.kind);
      }
    }
  }
  return used;
}

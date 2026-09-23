/**
 * @aicad/ir-types — TypeScript types and zod schemas for the Feature-Graph IR (`aicad.ir/0`)
 * and the evaluation report (`aicad.metrics/0`).
 *
 * Everything under `./generated/` is generated from the JSON Schemas that forge-ir derives from
 * its Rust types (see `scripts/generate.ts`). This file only adds thin, hand-written helpers.
 */
import type { z } from "zod";
import { IrDocumentSchema, type IrDocument, type LineSketchCurve, type Frame } from "./generated/ir-v0.js";
import { EvalReportSchema, type EvalReport } from "./generated/metrics-v0.js";

export * from "./generated/constants.js";
export * from "./generated/ir-v0.js";
export * from "./generated/metrics-v0.js";

/**
 * IR v1 (`aicad.ir/1`): types, zod schemas, constants (`v1.IR_SCHEMA`, `v1.HOLE_SIZES`,
 * `v1.ERROR_CODES`, …) and `v1.parseIrDocument` / `v1.parseEvalReport`.
 */
export * as v1 from "./v1.js";
/** The `aicad.metrics/1` report types and zod schemas (namespaced: names overlap with `v1`). */
export * as metricsV1 from "./generated/metrics-v1.js";

/** A 2D point or vector in sketch coordinates, mm: `[u, v]`. */
export type P2 = LineSketchCurve["start"];
/** A 3D point or vector in model coordinates, mm: `[x, y, z]`. */
export type P3 = Frame["origin"];

/** One problem found while parsing a JSON value against a schema. */
export interface IrParseIssue {
  /** JSON-pointer-like path to the offending value, e.g. `/parts/0/features/1/distance`. */
  path: string;
  message: string;
}

/** Thrown by {@link parseIrDocument} / {@link parseEvalReport} when the input does not match the schema. */
export class IrParseError extends Error {
  readonly issues: readonly IrParseIssue[];

  constructor(what: string, issues: IrParseIssue[]) {
    super(`invalid ${what}: ${issues.map((i) => `${i.path || "/"}: ${i.message}`).join("; ")}`);
    this.name = "IrParseError";
    this.issues = issues;
  }
}

export type SafeParseResult<T> = { success: true; data: T } | { success: false; error: IrParseError };

function toIssues(error: z.ZodError): IrParseIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => `/${String(p)}`).join(""),
    message: issue.message,
  }));
}

function decode(json: unknown): unknown {
  return typeof json === "string" ? JSON.parse(json) : json;
}

/**
 * Validate the *shape* of an IR document (the JSON Schema; equivalent to forge-ir's serde parse).
 * Accepts a parsed JSON value or JSON text. Semantic checks (duplicate names, forward references,
 * degenerate curves, …) are forge-ir's `validate`; `@aicad/cadscript` exports a TS mirror of it.
 *
 * Absent optional properties are left absent (defaults are never filled in), so parsing is lossless.
 * @throws {IrParseError} when the value does not match the schema.
 */
export function parseIrDocument(json: unknown): IrDocument {
  const r = safeParseIrDocument(json);
  if (!r.success) throw r.error;
  return r.data;
}

/** Like {@link parseIrDocument} but returns a result instead of throwing (JSON syntax errors still throw). */
export function safeParseIrDocument(json: unknown): SafeParseResult<IrDocument> {
  const r = IrDocumentSchema.safeParse(decode(json));
  return r.success
    ? { success: true, data: r.data }
    : { success: false, error: new IrParseError("IR document", toIssues(r.error)) };
}

/**
 * Validate the shape of an `aicad.metrics/0` evaluation report (parsed JSON value or JSON text).
 * @throws {IrParseError} when the value does not match the schema.
 */
export function parseEvalReport(json: unknown): EvalReport {
  const r = EvalReportSchema.safeParse(decode(json));
  if (!r.success) throw new IrParseError("evaluation report", toIssues(r.error));
  return r.data;
}

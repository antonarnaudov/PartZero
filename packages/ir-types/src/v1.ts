/**
 * IR v1 (`aicad.ir/1`): generated types, zod schemas and constants, plus thin parse helpers.
 * Exported from the package root as the namespace `v1` (the v0 exports are unchanged).
 *
 * Semantics: forge/crates/forge-ir/SPEC-v1-DRAFT.md. Shape validation only: the coded
 * rejections of SPEC-v1 §0.5 (raw pre-checks, then structural validation) are forge-ir's
 * `v1::from_json`; CadScript v1 (W8) mirrors them.
 */
import type { z } from "zod";
import { IrDocumentSchema, type IrDocument } from "./generated/ir-v1.js";
import { EvalReportSchema, type EvalReport } from "./generated/metrics-v1.js";

export * from "./generated/constants-v1.js";
export * from "./generated/ir-v1.js";

/** One problem found while parsing a JSON value against a schema. */
export interface ParseIssue {
  /** JSON-pointer-like path to the offending value. */
  path: string;
  message: string;
}

/** Thrown by {@link parseIrDocument} / {@link parseEvalReport} when the input does not match the schema. */
export class ParseError extends Error {
  readonly issues: readonly ParseIssue[];

  constructor(what: string, issues: ParseIssue[]) {
    super(`invalid ${what}: ${issues.map((i) => `${i.path || "/"}: ${i.message}`).join("; ")}`);
    this.name = "IrV1ParseError";
    this.issues = issues;
  }
}

function toIssues(error: z.ZodError): ParseIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => `/${String(p)}`).join(""),
    message: issue.message,
  }));
}

function decode(json: unknown): unknown {
  return typeof json === "string" ? JSON.parse(json) : json;
}

/**
 * Validate the shape of an `aicad.ir/1` document (parsed JSON or JSON text). Absent optional
 * properties stay absent (defaults are never filled in), so parsing is lossless.
 * @throws {ParseError} when the value does not match the schema.
 */
export function parseIrDocument(json: unknown): IrDocument {
  const r = IrDocumentSchema.safeParse(decode(json));
  if (!r.success) throw new ParseError("IR v1 document", toIssues(r.error));
  return r.data;
}

/**
 * Validate the shape of an `aicad.metrics/1` report (parsed JSON or JSON text).
 * @throws {ParseError} when the value does not match the schema.
 */
export function parseEvalReport(json: unknown): EvalReport {
  const r = EvalReportSchema.safeParse(decode(json));
  if (!r.success) throw new ParseError("aicad.metrics/1 report", toIssues(r.error));
  return r.data;
}

export type { EvalReport };

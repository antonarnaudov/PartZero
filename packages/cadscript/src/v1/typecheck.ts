/**
 * `typecheckV1(source)`: the TypeScript checker over a CadScript v1 file, with the `@aicad/std`
 * v1 declarations (`std/v1/index.d.ts`) mounted as the `@aicad/std` module. Same guarantees as
 * the v0 `typecheck` (never throws or hangs; `CS_TOO_COMPLEX` beyond the limits), with the v1
 * nesting limits of `compileV1` (`LIMITS_V1`), so that every printed document type-checks.
 */
import { LIMITS_V1 } from "../complexity.js";
import type { Diagnostic } from "../diagnostics.js";
import { STD_V1_DTS } from "../generated/std-v1-dts.js";
import { stdLibDiagnostics, typecheckWith } from "../typecheck.js";

/**
 * Type-check CadScript v1 source; `[]` means it type-checks. Codes are `TS####`.
 *
 * Beyond the type checker's work limits (`MAX_CHECKED_DEPTH`, `MAX_OVERLOADS`, `MAX_FLOW_STEPS`:
 * tsc's time grows with the square of such input) the file is not type-checked, and the result
 * is one `CS_TOO_COMPLEX` **warning** ("not type-checked: …"): `compileV1` has no such limit, and
 * the printer writes every valid document (a part with thousands of features among them), so
 * `cadscript check` must not fail a file that compiles. The nesting limits (`LIMITS_V1`) stay
 * errors: `compileV1` rejects the same input.
 */
export function typecheckV1(source: string): Diagnostic[] {
  return typecheckWith(source, STD_V1_DTS, LIMITS_V1, "warning");
}

/** @internal Diagnostics of the v1 std declarations themselves (must be empty). */
export function stdV1LibDiagnostics(): Diagnostic[] {
  return stdLibDiagnostics(STD_V1_DTS);
}

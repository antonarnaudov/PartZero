/**
 * The `cadscript` command line (logic only; `cli.ts` wires it to the process).
 *
 *   cadscript compile <file.cad.ts> [--base old.json] [-o out.json]   CadScript → IR v1 JSON (stdout)
 *   cadscript print <file.json> [-o out.cad.ts]                       IR JSON → canonical CadScript v1
 *   cadscript check <file.cad.ts> [--json] [--strict]                 compile + typecheck, report diagnostics
 *   cadscript migrate <file.json> [-o out.json]                       aicad.ir/0 → aicad.ir/1 (canonical JSON)
 *
 * CadScript v1 (`aicad.ir/1`) is the default, as SPEC-v1 §9.1 says ("the CadScript compiler
 * always emits v1; printing a v0 IR prints its migration"): a v0 source compiles to its v1
 * migration, a v0 document prints as its migration, and v1 output is canonical JSON (forge-ir's
 * `to_json`, byte for byte). `--v1` is accepted and changes nothing. `--v0` selects the legacy v0
 * paths (the package root's API, which the app and agent still use): `compile --v0` writes
 * aicad.ir/0, `print --v0` prints a v0 document as CadScript v0, `check --v0` checks against
 * `@aicad/std` v0.
 *
 * IR input on the v1 paths (`migrate`, `print`, a `--base` of `compile`) goes through forge-ir's
 * whole loading pipeline (`loadIrText`: the JSON text readers, then v0 validation and migration,
 * or the v1 pre-checks, typed parse and validation). A rejected document is reported with its
 * codes and paths, and the command exits 1 (an error in the input), as forge-ir would reject it
 * (SPEC-v1 §9.1 "rejections are preserved"). The v0 paths (`--v0`) keep v0's reading: the typed
 * parse only.
 */
import { parseIrDocument, v1 as irV1, type IrDocument } from "@aicad/ir-types";
import { compile } from "./compile.js";
import { formatDiagnostic, type Diagnostic } from "./diagnostics.js";
import { print } from "./print.js";
import { typecheck } from "./typecheck.js";
import { analyzeV1, compileV1 } from "./v1/compile.js";
import { toJson } from "./v1/json.js";
import { printV1 } from "./v1/print.js";
import { typecheckV1 } from "./v1/typecheck.js";
import { JsonTextError, parseIrJsonText } from "./v1/v0json.js";
import { loadIrText, type LoadResult } from "./v1/validate.js";

export interface CliIo {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const USAGE = `Usage:
  cadscript compile <file.cad.ts> [--base <old.json>] [-o <out.json>] [--v0]
      Compile CadScript to IR v1 JSON (aicad.ir/1, canonical; stdout unless -o). A v0 source
      compiles to its migration. --base keeps part/feature ids and reference captures from an
      earlier IR (either version).
  cadscript print <file.json> [-o <out.cad.ts>] [--v0]
      Print an IR JSON document as canonical CadScript v1 (an aicad.ir/0 document prints as its
      migration).
  cadscript check <file.cad.ts> [--json] [--strict] [--v0]
      Compile and type-check against @aicad/std v1; print diagnostics (a JSON array with --json).
      A file beyond the type checker's work limits (thousands of features or tags) is compiled
      but not type-checked: a CS_TOO_COMPLEX warning ("not type-checked: …"), exit code 0.
      --strict counts warnings as errors (exit 1), e.g. for a CI gate.
  cadscript migrate <file.json> [-o <out.json>]
      Migrate an aicad.ir/0 document to aicad.ir/1 (canonical JSON; id rewrites on stderr).
IR input is loaded as forge-ir loads it: an invalid document is rejected with its codes.
--v1 is the default (accepted, changes nothing). --v0 selects legacy CadScript v0 (aicad.ir/0):
compile writes v0 IR, print prints a v0 document as v0 source, check uses @aicad/std v0.
Exit codes: 0 ok, 1 errors in the input, 2 usage error.
`;

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const withValue = new Set(["--base", "-o", "--out"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (withValue.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      flags.set(a === "--out" ? "-o" : a, v);
    } else if (a.startsWith("-")) {
      flags.set(a, true);
    } else {
      positional.push(a);
    }
  }
  return { command: positional.shift(), positional, flags };
}

class UsageError extends Error {}

/** The schema of an IR JSON file (read as forge-ir reads it), and the text; reports unreadable JSON. */
function sniffIr(io: CliIo, path: string): { text: string; v1: boolean } | undefined {
  const text = io.readFile(path);
  let raw: { schema?: unknown } | null;
  try {
    raw = parseIrJsonText(text) as { schema?: unknown } | null;
  } catch (e) {
    if (!(e instanceof JsonTextError)) throw e;
    io.stderr(`${path}: ${e.message}\n`);
    return undefined;
  }
  return { text, v1: raw !== null && typeof raw === "object" && raw.schema === irV1.IR_SCHEMA };
}

/** A v0 document for the v0 paths: v0's reading (typed parse, no validation). */
function readV0(text: string): IrDocument {
  return parseIrDocument(parseIrJsonText(text));
}

/** An IR document of either version through forge-ir's loading pipeline; reports a rejection. */
function loadIr(io: CliIo, path: string, text: string): Extract<LoadResult, { ok: true }> | undefined {
  const r = loadIrText(text);
  if (r.ok) return r;
  if (r.parseError) io.stderr(`${path}: ${r.parseError.path ? `${r.parseError.path}: ` : ""}${r.parseError.message}\n`);
  for (const e of r.errors) io.stderr(`${path}: error ${e.code} at ${e.path || "/"}: ${e.message}\n`);
  io.stderr(`${path}: rejected (not a valid ${r.version === 0 ? "aicad.ir/0" : r.version === 1 ? "aicad.ir/1" : "IR"} document)\n`);
  return undefined;
}

function report(io: CliIo, file: string, diags: Diagnostic[]): void {
  for (const d of diags) io.stderr(`${formatDiagnostic(d, file)}\n`);
}

/** Run the CLI; returns the process exit code. */
export function main(argv: string[], io: CliIo): number {
  let args: Parsed;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.stderr(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { command, positional, flags } = args;
  if (flags.has("--help") || flags.has("-h") || command === "help") {
    io.stdout(USAGE);
    return 0;
  }
  if (!command) {
    io.stderr(USAGE);
    return 2;
  }
  const known: Record<string, string[]> = { compile: ["--base", "-o", "--v1", "--v0"], print: ["-o", "--v1", "--v0"], check: ["--json", "--strict", "--v1", "--v0"], migrate: ["-o"] };
  const allowed = known[command];
  if (!allowed) {
    io.stderr(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  const unknownFlag = [...flags.keys()].find((f) => !allowed.includes(f));
  if (unknownFlag || positional.length !== 1) {
    io.stderr(`${unknownFlag ? `unknown option ${unknownFlag}` : `${command} takes exactly one file`}\n\n${USAGE}`);
    return 2;
  }
  if (flags.has("--v0") && flags.has("--v1")) {
    io.stderr(`--v0 and --v1 exclude each other\n\n${USAGE}`);
    return 2;
  }
  const v0 = flags.has("--v0");
  const file = positional[0]!;
  const out = flags.get("-o");
  const emit = (text: string): void => (typeof out === "string" ? io.writeFile(out, text) : io.stdout(text));

  try {
    switch (command) {
      case "compile": {
        const basePath = flags.get("--base");
        const base = typeof basePath === "string" ? sniffIr(io, basePath) : undefined;
        if (typeof basePath === "string" && !base) return 1;
        if (v0) {
          if (base?.v1) {
            io.stderr(`${basePath}: an aicad.ir/1 document cannot be the base of a CadScript v0 compile (drop --v0)\n`);
            return 1;
          }
          const result = compile(io.readFile(file), { base: base ? readV0(base.text) : undefined, fileName: file });
          report(io, file, result.diagnostics);
          if (!result.ir) return 1;
          emit(`${JSON.stringify(result.ir, null, 2)}\n`);
          return 0;
        }
        let baseDoc: irV1.IrDocument | undefined;
        if (base && typeof basePath === "string") {
          const loaded = loadIr(io, basePath, base.text);
          if (!loaded) return 1;
          baseDoc = loaded.doc;
        }
        const result = compileV1(io.readFile(file), { base: baseDoc, fileName: file });
        report(io, file, result.diagnostics);
        if (!result.ir) return 1;
        emit(`${toJson(result.ir)}\n`);
        return 0;
      }
      case "print": {
        const input = sniffIr(io, file);
        if (!input) return 1;
        if (v0) {
          if (input.v1) {
            io.stderr(`${file}: an aicad.ir/1 document cannot be printed as CadScript v0 (drop --v0)\n`);
            return 1;
          }
          emit(print(readV0(input.text)));
          return 0;
        }
        const loaded = loadIr(io, file, input.text);
        if (!loaded) return 1;
        emit(printV1(loaded.doc));
        return 0;
      }
      case "migrate": {
        const loaded = loadIr(io, file, io.readFile(file));
        if (!loaded) return 1;
        if (loaded.migration && loaded.migration.renames.length > 0) io.stderr(`${JSON.stringify(loaded.migration, null, 2)}\n`);
        emit(`${toJson(loaded.doc)}\n`);
        return 0;
      }
      default: {
        const source = io.readFile(file);
        const isV1 = !v0;
        // Source beyond the nesting limits never gets past the parser, and the type checker would
        // report the same CS_TOO_COMPLEX: report it once. A CS_TOO_COMPLEX of a later compile stage
        // (v1: the IR JSON nesting bound, query alias expansion) still type-checks the file. (v0's
        // compile reports CS_TOO_COMPLEX for the nesting limits only.)
        let compiled: Diagnostic[];
        let unparsed: boolean;
        if (isV1) {
          const analysis = analyzeV1(source, { fileName: file });
          compiled = analysis.result.diagnostics;
          unparsed = analysis.unparsed === true;
        } else {
          compiled = compile(source, { fileName: file }).diagnostics;
          unparsed = compiled.some((d) => d.code === "CS_TOO_COMPLEX");
        }
        const found = [...compiled, ...(unparsed ? [] : isV1 ? typecheckV1(source) : typecheck(source))];
        // --strict: warnings count as errors (among them "not type-checked" beyond the work limits).
        const diags = flags.has("--strict") ? found.map((d): Diagnostic => (d.severity === "warning" ? { ...d, severity: "error" } : d)) : found;
        if (flags.has("--json")) io.stdout(`${JSON.stringify(diags, null, 2)}\n`);
        else report(io, file, diags);
        const errors = diags.filter((d) => d.severity === "error").length;
        if (!flags.has("--json")) io.stderr(errors === 0 ? `${file}: ok\n` : `${file}: ${errors} error${errors === 1 ? "" : "s"}\n`);
        return errors === 0 ? 0 : 1;
      }
    }
  } catch (e) {
    io.stderr(`${file}: ${(e as Error).message}\n`);
    return 1;
  }
}

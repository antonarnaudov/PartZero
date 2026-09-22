/**
 * The `cadscript` command line (logic only; `cli.ts` wires it to the process).
 *
 *   cadscript compile <file.cad.ts> [--base old.json] [-o out.json]   CadScript → IR JSON (stdout)
 *   cadscript print <file.json> [-o out.cad.ts]                       IR JSON → canonical CadScript
 *   cadscript check <file.cad.ts> [--json]                            compile + typecheck, report diagnostics
 */
import { parseIrDocument, type IrDocument } from "@aicad/ir-types";
import { compile } from "./compile.js";
import { formatDiagnostic, type Diagnostic } from "./diagnostics.js";
import { print } from "./print.js";
import { typecheck } from "./typecheck.js";

export interface CliIo {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const USAGE = `Usage:
  cadscript compile <file.cad.ts> [--base <old.json>] [-o <out.json>]
      Compile CadScript to IR JSON (stdout unless -o). --base keeps part/feature ids from an earlier IR.
  cadscript print <file.json> [-o <out.cad.ts>]
      Print an IR JSON document as canonical CadScript.
  cadscript check <file.cad.ts> [--json]
      Compile and type-check; print diagnostics (or a JSON array with --json).
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

function readIr(io: CliIo, path: string): IrDocument {
  return parseIrDocument(io.readFile(path));
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
  const known: Record<string, string[]> = { compile: ["--base", "-o"], print: ["-o"], check: ["--json"] };
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
  const file = positional[0]!;
  const out = flags.get("-o");
  const emit = (text: string): void => (typeof out === "string" ? io.writeFile(out, text) : io.stdout(text));

  try {
    switch (command) {
      case "compile": {
        const basePath = flags.get("--base");
        const base = typeof basePath === "string" ? readIr(io, basePath) : undefined;
        const result = compile(io.readFile(file), { base, fileName: file });
        report(io, file, result.diagnostics);
        if (!result.ir) return 1;
        emit(`${JSON.stringify(result.ir, null, 2)}\n`);
        return 0;
      }
      case "print": {
        emit(print(readIr(io, file)));
        return 0;
      }
      default: {
        const source = io.readFile(file);
        const diags = [...compile(source, { fileName: file }).diagnostics, ...typecheck(source)];
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

#!/usr/bin/env node
import { main } from "./cli-main.js";

main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`aicad-evals: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 3;
  },
);

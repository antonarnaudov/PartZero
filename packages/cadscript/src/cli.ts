#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { main } from "./cli-main.js";

process.exitCode = main(process.argv.slice(2), {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => writeFileSync(path, content),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

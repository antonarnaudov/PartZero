import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHelp } from "../../src/cli/detect.js";
import type { CliEvent } from "../../src/cli/events.js";
import type { CliBinary, CliProvider, ParseContext } from "../../src/cli/provider.js";
import type { CliProviderId } from "../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixturePath(rel: string): string {
  return join(here, "fixtures", rel);
}

export function readFixture(rel: string): string {
  return readFileSync(fixturePath(rel), "utf8");
}

export async function* linesOf(text: string): AsyncGenerator<string> {
  for (const l of text.split("\n")) if (l.trim().length > 0) yield l;
}

export async function parseFixture(provider: CliProvider, rel: string, ctx: Partial<ParseContext> = {}): Promise<CliEvent[]> {
  const out: CliEvent[] = [];
  const full: ParseContext = { mode: "completion", allowed: new Set(), serverName: "cad", ...ctx };
  for await (const e of provider.parseEvents(linesOf(readFixture(rel)), full)) out.push(e);
  return out;
}

/** A CliBinary for pure tests (buildArgs, lockdown) from a help fixture. */
export function fakeBinary(provider: CliProviderId, version: string, helpFiles: readonly string[], realPath = `/opt/fake/bin/${provider}`): CliBinary {
  return {
    provider,
    path: realPath,
    realPath,
    source: "path",
    version,
    rawVersion: version,
    help: parseHelp(helpFiles.map((f) => readFixture(`help/${f}`))),
    stat: { size: 1, mtimeMs: 1 },
  };
}

export function tempDir(prefix = "aicad-cli-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface FakeScenario {
  mode?: "replay" | "hang" | "silent" | "stall" | "huge" | "nonjson" | "grandchild" | "ignore-term";
  fixture?: string;
  /** One fixture per invocation, in order (needs `stateFile`). */
  fixtures?: string[];
  stateFile?: string;
  delayMs?: number;
  exitCode?: number;
  stderr?: string;
  version?: string;
  help?: string;
  auth?: Record<string, unknown>;
  record?: string;
  pidFile?: string;
}

/** Write an executable fake CLI named `name` into `dir`: a node script (absolute shebang) that runs fake-cli.mjs. */
export function makeFakeCli(dir: string, name: string, scenario: FakeScenario): string {
  const path = join(dir, name);
  const mod = pathToFileURL(join(here, "fake", "fake-cli.mjs")).href;
  writeFileSync(path, `#!${process.execPath}\nimport(${JSON.stringify(mod)}).then((m) => m.main(${JSON.stringify(scenario)}));\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A CliBinary for a generated fake (stat taken from disk so the transport's re-stat passes). */
export function binaryFor(provider: CliProviderId, path: string, version: string, helpFiles: readonly string[]): CliBinary {
  const st = statSync(path);
  return { ...fakeBinary(provider, version, helpFiles, path), path, realPath: realpathSync(path), stat: { size: st.size, mtimeMs: st.mtimeMs } };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fake `claude` binary for the keyless provider tests (unit tests and `providers.e2e.ts`): a two-line Node wrapper
 * named `claude` that runs `fixtures/fake-cli/fake-claude.mjs` with a scenario. Point the app at its directory with
 * `AICAD_CLI_DIRS` (or a Settings path override) and it is detected as Claude Code 2.1.260, logged in with a Max plan,
 * and answers every model call from a script of recorded-shape stream-json. No network, no key, no real CLI.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE_MODULE = join(here, "fixtures", "fake-cli", "fake-claude.mjs");
export const FAKE_CLAUDE_HELP = join(here, "fixtures", "fake-cli", "claude-2.1.260-help.txt");
/** The same script the scripted-transport e2e replays: "make the plate 2 mm thicker" on the NEMA 17 template. */
export const NEMA_THICKER_SCRIPT = join(here, "fixtures", "nema17-thicker.script.json");

/** What the fake recorded about one invocation. */
export interface FakeCall {
  argv: string[];
  cwd: string;
  cwdMode: number;
  /** Variable names only. */
  env: string[];
  tmpdir: string | null;
  stdinBytes: number;
  promptInArgv: boolean;
  role: "triage" | "spec_writer" | "designer";
  turn: number;
  tools: string[];
}

export interface FakeClaude {
  /** The directory holding `claude` (for `AICAD_CLI_DIRS`). */
  binDir: string;
  bin: string;
  /** `realpath(bin)`: what detection records and the tripwire reports (macOS temp dirs are behind /var → /private/var). */
  realBin: string;
  setLoggedIn(loggedIn: boolean): void;
  /** Model invocations so far, oldest first (version, help and auth probes are not recorded). */
  calls(): FakeCall[];
}

export interface FakeClaudeOptions {
  script?: string;
  costUsd?: number;
  delayMs?: number;
  planStatus?: "allowed" | "allowed_warning" | "rejected";
  loggedIn?: boolean;
  /** The tool list the fake's `init` reports (default `["StructuredOutput"]`); add "Bash" to trip the lockdown check. */
  initTools?: string[];
  /** The version it reports (default "2.1.260 (Claude Code)"). */
  version?: string;
}

export function makeFakeClaude(root: string, options: FakeClaudeOptions = {}): FakeClaude {
  const binDir = join(root, "bin");
  const record = join(root, "calls");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(record, { recursive: true });
  const state = join(root, "state.json");
  const setLoggedIn = (loggedIn: boolean): void => writeFileSync(state, JSON.stringify({ loggedIn, plan: "max" }));
  setLoggedIn(options.loggedIn ?? true);
  const scenario = {
    script: options.script ?? NEMA_THICKER_SCRIPT,
    help: FAKE_CLAUDE_HELP,
    state,
    record,
    ...(options.costUsd === undefined ? {} : { costUsd: options.costUsd }),
    ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
    ...(options.planStatus === undefined ? {} : { planStatus: options.planStatus }),
    ...(options.initTools === undefined ? {} : { initTools: options.initTools }),
    ...(options.version === undefined ? {} : { version: options.version }),
  };
  const bin = join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  // CommonJS (no extension, no package.json above a temp dir): a dynamic import loads the ESM fake.
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(FAKE_CLAUDE_MODULE).href)}).then((m) => m.main(${JSON.stringify(scenario)})).catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(3); });\n`,
  );
  chmodSync(bin, 0o755);
  return {
    binDir,
    bin,
    realBin: realpathSync(bin),
    setLoggedIn,
    calls: () =>
      readdirSync(record)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(record, f), "utf8")) as FakeCall),
  };
}

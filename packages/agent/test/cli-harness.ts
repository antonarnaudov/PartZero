/**
 * Offline harness for the real CLI driver: a fake `claude` binary (fake-cli/fake-claude.mjs) found
 * by the real `ClaudeCliProvider.detect()`, the real MCP host (`createMcpHost` + the built
 * `aicad-mcp` shim) and `CliAgentRuntime`, in a private temp dir that `dispose()` removes.
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMcpHost, nodeShimCommand } from "@aicad/mcp-server";
import { CLI_PROVIDERS, setDefaultWorkspaceRoot, type CliBinary } from "@aicad/llm-gateway/cli";
import { CliAgentRuntime, type CliAgentRuntimeOptions } from "../src/cli-runtime.js";

const here = dirname(fileURLToPath(import.meta.url));

/** One scripted model message of a runtime turn (see fake-claude.mjs). */
export interface FakeMsg {
  text?: string;
  calls?: Array<{ name: string; args?: Record<string, unknown>; bare?: boolean }>;
  usage?: { input?: number; output?: number };
  sleepMs?: number;
  hang?: boolean;
  raw?: unknown;
}

export interface FakeRuntimePhase {
  turns?: FakeMsg[][];
  /** A recorded (scrubbed) Claude Code stream to replay with real MCP calls (fake-claude.mjs "runtime replay"). */
  replay?: string;
  extraTools?: string[];
  planUsage?: Record<string, unknown>;
  /** Exit after each turn (resume-style CLIs); a `--resume` process continues with the next scripted turn. */
  exitAfterTurn?: boolean;
  /** `stop_reason` of each turn's `result` (default "end_turn"); Claude reports the real one only there. */
  resultStop?: string[];
}

export interface FakeClaudeScenario {
  version?: string;
  pricing?: { input: number; output: number };
  runtime?: Partial<Record<"build" | "spec" | "ask", FakeRuntimePhase>>;
  completion?: Partial<Record<"triage" | "designer" | "spec_writer" | "plain", unknown[]>>;
}

export interface Invocation {
  pid: number;
  mode: "runtime" | "completion";
  argv: string[];
  cwd: string;
  envNames: string[];
  tmpdir: string | null;
  claudeTmp: string | null;
  hasTicket: boolean;
  system: string;
}

/** The built shim is needed (the test script of @aicad/mcp-server builds it; so does `pnpm -r build`). */
export function shimBuilt(): boolean {
  try {
    nodeShimCommand();
    return true;
  } catch {
    return false;
  }
}

/**
 * The real-broker tests skip only on a developer machine without the built shim. In CI (or with
 * AICAD_REQUIRE_MCP_SHIM=1) they always run, so a missing shim fails them instead of hiding them.
 * (`turbo run test` builds @aicad/mcp-server first: it is a devDependency of this package.)
 */
export function skipRealBroker(): boolean {
  const ci = process.env["CI"];
  const required = (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0") || process.env["AICAD_REQUIRE_MCP_SHIM"] === "1";
  return !required && !shimBuilt();
}

function jsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

export class FakeClaude {
  readonly dir: string;
  readonly bin: string;
  readonly env: Record<string, string>;
  #binary: CliBinary | null = null;

  constructor(scenario: FakeClaudeScenario) {
    // Short path: the broker socket lives under it (macOS sun_path ≤ 103 bytes).
    this.dir = mkdtempSync(join(realpathSync(tmpdir()), "art-"));
    const scenarioPath = join(this.dir, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify({ ...scenario, recordDir: this.dir }));
    this.bin = join(this.dir, "claude");
    const mod = pathToFileURL(join(here, "fake-cli", "fake-claude.mjs")).href;
    writeFileSync(this.bin, `#!${process.execPath}\nimport(${JSON.stringify(mod)}).then((m) => m.main(${JSON.stringify(scenarioPath)}));\n`);
    chmodSync(this.bin, 0o755);
    // Detection probes use the default workspace root: keep them inside this dir too.
    setDefaultWorkspaceRoot(join(this.dir, "probe"));
    // The host env: allowlisted again per CLI. The fake secret proves the deny pattern strips it.
    this.env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? this.dir, LANG: "C.UTF-8", ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key", CI: "1" };
  }

  /** Real detection (version, help, lockdown) of the fake binary. */
  async binary(): Promise<CliBinary> {
    if (this.#binary) return this.#binary;
    const d = await CLI_PROVIDERS.get("claude-cli")!.detect({ overridePath: this.bin, env: this.env, extraDirs: [], loginShell: false });
    if (d.status !== "ready" || d.binary === null) throw new Error(`fake claude not ready: ${d.status} ${d.detail}`);
    this.#binary = d.binary;
    return d.binary;
  }

  runtime(options: Partial<CliAgentRuntimeOptions> = {}): CliAgentRuntime {
    return new CliAgentRuntime({
      binary: () => this.binary(),
      env: () => this.env,
      mcpHost: createMcpHost({ shim: nodeShimCommand() }),
      workspaceRoot: join(this.dir, "ws"),
      closeGraceMs: 1_000,
      ...options,
    });
  }

  invocations(): Invocation[] {
    return jsonl<Invocation>(join(this.dir, "invocations.jsonl"));
  }

  calls(): Array<{ phase: string; index: number; name: string; isError: boolean; text: string }> {
    return jsonl(join(this.dir, "calls.jsonl"));
  }

  turns(): Array<{ phase: string; index: number; user: string }> {
    return jsonl(join(this.dir, "turns.jsonl"));
  }

  phases(): Array<{ phase: string; pid: number; mcpPid: number | null; tools: string[] }> {
    return jsonl(join(this.dir, "phases.jsonl"));
  }

  resumes(): Array<{ phase: string; sessionId: string; pid: number }> {
    return jsonl(join(this.dir, "resumes.jsonl"));
  }

  completions(): Array<{ role: string; n: number; via: string; stdin: string }> {
    return jsonl(join(this.dir, "completion.jsonl"));
  }

  /** Workspace dirs left under the runtime's root (the socket parent `s` is shared and may stay). */
  leftoverWorkspaces(): string[] {
    const root = join(this.dir, "ws");
    if (!existsSync(root)) return [];
    const sockets = existsSync(join(root, "s")) ? readdirSync(join(root, "s")).map((n) => `s/${n}`) : [];
    return [...readdirSync(root).filter((n) => n !== "s"), ...sockets];
  }

  dispose(): void {
    setDefaultWorkspaceRoot(null);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export function isAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `cond` holds (or the timeout passes). */
export async function until(cond: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

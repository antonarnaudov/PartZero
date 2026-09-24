import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Process control for CLI children (docs/CLI-PROVIDERS.md §5.7 and §5.8, frozen). Every CLI runs in its own process
 * group (so the MCP shim and any grandchild die with it), with an explicit environment, `shell: false`, and bounded
 * output. A registry of live groups is killed when the host process exits.
 */

export const OUTPUT_LIMITS = {
  /** Longer stdout lines are dropped and counted. */
  maxLineBytes: 1 << 20,
  /** More than this many dropped lines -> bad_output. */
  maxDroppedLines: 3,
  /** Total stdout per invocation; more -> kill + bad_output. */
  maxStdoutBytes: 64 << 20,
  /** Non-JSON stdout lines are ignored and counted; more than this -> bad_output. */
  maxNonJsonLines: 100,
  /** stderr ring buffer. */
  stderrRingBytes: 64 << 10,
  /** `stderrTail` size. */
  stderrTailBytes: 8 << 10,
} as const;

export const KILL_TIMING = { closeInputGraceMs: 2_000, termGraceMs: 3_000 } as const;
export const START_TIMEOUT_MS = 60_000;

export type StdinSpec = { kind: "ignore" } | { kind: "text"; text: string } | { kind: "stream-json"; first: string };

export interface SpawnSpec {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: StdinSpec;
}

export interface OutputStats {
  stdoutBytes: number;
  droppedLines: number;
  nonJsonLines: number;
  overflow: boolean;
}

/** A spawned CLI process group. `lines` must be consumed (it is backed by the stdout pipe). */
export interface CliProcess {
  readonly pid: number | null;
  readonly lines: AsyncIterable<string>;
  readonly stats: OutputStats;
  readonly exited: Promise<{ code: number | null; signal: string | null; error: Error | null }>;
  readonly hasExited: boolean;
  writeLine(line: string): void;
  closeInput(): void;
  /** Signal the whole group (POSIX) or the tree (Windows). Never throws. */
  signal(sig: "SIGTERM" | "SIGKILL"): void;
  stderrTail(): string;
}

// ------------------------------------------------------------------------------------------ live-process registry

const LIVE = new Set<CliProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const p = globalThis.process;
  p.once("exit", () => killAllCliProcesses());
}

/** Kill every live CLI process group (host shutdown, worker crash). Synchronous. */
export function killAllCliProcesses(): number {
  let n = 0;
  for (const proc of LIVE) {
    proc.signal("SIGKILL");
    n += 1;
  }
  LIVE.clear();
  return n;
}

/** Process-group ids of live CLI processes (for a host-side backstop). */
export function liveCliProcessGroups(): number[] {
  return [...LIVE].map((p) => p.pid).filter((pid): pid is number => pid !== null);
}

// ------------------------------------------------------------------------------------------ helpers

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Replace secret values and token-looking strings. */
export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 6) out = out.split(s).join("[redacted]");
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[redacted]");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]");
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * Windows: an npm `.cmd` shim is resolved to `node <script>` by parsing the shim's target; `shell: true` is never
 * used. Returns the original file when it is not a recognizable shim.
 */
export function resolveWindowsShim(file: string, nodePath: string | null): { file: string; prefixArgs: string[] } {
  if (!/\.(cmd|bat)$/i.test(file)) return { file, prefixArgs: [] };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { file, prefixArgs: [] };
  }
  const m = /"%(?:~dp0|dp0%)\\?([^"%]+?\.(?:c|m)?js)"/i.exec(text);
  if (m === null || m[1] === undefined || nodePath === null) throw new Error(`cannot resolve the npm shim ${file} to a script; set the CLI path to the real executable`);
  return { file: nodePath, prefixArgs: [join(dirname(file), m[1])] };
}

// ------------------------------------------------------------------------------------------ spawn

class LineQueue implements AsyncIterable<string> {
  readonly #items: string[] = [];
  #waiter: ((v: IteratorResult<string>) => void) | null = null;
  #ended = false;
  #iterating = false;

  push(line: string): void {
    if (this.#ended) return;
    const w = this.#waiter;
    if (w !== null) {
      this.#waiter = null;
      w({ value: line, done: false });
    } else this.#items.push(line);
  }

  end(): void {
    this.#ended = true;
    const w = this.#waiter;
    if (w !== null) {
      this.#waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    if (this.#iterating) throw new Error("CLI output lines can only be iterated once");
    this.#iterating = true;
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiter = resolve;
        });
      },
      return: () => {
        this.#items.length = 0;
        this.#ended = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export interface SpawnCliOptions {
  secrets?: readonly string[];
  onStderrLine?(line: string): void;
  limits?: Partial<typeof OUTPUT_LIMITS>;
}

/** Spawn a CLI in its own process group with an explicit environment. Never uses a shell. */
export function spawnCli(spec: SpawnSpec, options: SpawnCliOptions = {}): CliProcess {
  const limits = { ...OUTPUT_LIMITS, ...options.limits };
  const secrets = options.secrets ?? [];
  const win = process.platform === "win32";
  let file = spec.file;
  let args = [...spec.args];
  if (win) {
    const nodeOnPath = findOnPath("node.exe", spec.env["PATH"] ?? "", ";");
    const r = resolveWindowsShim(file, nodeOnPath);
    file = r.file;
    args = [...r.prefixArgs, ...args];
  }
  const stats: OutputStats = { stdoutBytes: 0, droppedLines: 0, nonJsonLines: 0, overflow: false };
  const queue = new LineQueue();
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  let stderrPartial = "";
  let exitedFlag = false;
  let child: ChildProcess;
  let resolveExit!: (v: { code: number | null; signal: string | null; error: Error | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null; error: Error | null }>((r) => {
    resolveExit = r;
  });

  try {
    child = spawn(file, args, {
      cwd: spec.cwd,
      env: { ...spec.env },
      stdio: [spec.stdin.kind === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
      detached: !win,
      windowsHide: true,
      shell: false,
    });
  } catch (e) {
    queue.end();
    exitedFlag = true;
    resolveExit({ code: null, signal: null, error: e as Error });
    return {
      pid: null,
      lines: queue,
      stats,
      exited,
      hasExited: true,
      writeLine() {},
      closeInput() {},
      signal() {},
      stderrTail: () => "",
    };
  }

  let stdoutDone = false;
  let closeInfo: { code: number | null; signal: string | null; error: Error | null } | null = null;
  const finish = (): void => {
    if (exitedFlag || !stdoutDone || closeInfo === null) return;
    exitedFlag = true;
    LIVE.delete(proc);
    // Reap stragglers left in the group (an MCP shim that ignored stdin EOF, a forked grandchild).
    proc.signal("SIGTERM");
    resolveExit(closeInfo);
  };

  // stdout -> bounded lines
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let dropping = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    stats.stdoutBytes += chunk.length;
    if (stats.stdoutBytes > limits.maxStdoutBytes) {
      if (!stats.overflow) {
        stats.overflow = true;
        proc.signal("SIGKILL");
      }
      return;
    }
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      const piece = nl === -1 ? chunk.subarray(start) : chunk.subarray(start, nl);
      if (!dropping) {
        if (pendingBytes + piece.length > limits.maxLineBytes) {
          dropping = true;
          pending = [];
          pendingBytes = 0;
        } else {
          pending.push(piece);
          pendingBytes += piece.length;
        }
      }
      if (nl === -1) break;
      if (dropping) {
        stats.droppedLines += 1;
        dropping = false;
      } else {
        const line = Buffer.concat(pending).toString("utf8").replace(/\r$/, "");
        pending = [];
        pendingBytes = 0;
        if (line.trim().length > 0) {
          if (line.trimStart().startsWith("{")) queue.push(line);
          else stats.nonJsonLines += 1;
        }
      }
      start = nl + 1;
    }
  });
  child.stdout?.on("end", () => {
    if (!dropping && pendingBytes > 0) {
      const line = Buffer.concat(pending).toString("utf8").replace(/\r$/, "");
      if (line.trimStart().startsWith("{")) queue.push(line);
      else if (line.trim().length > 0) stats.nonJsonLines += 1;
    } else if (dropping) stats.droppedLines += 1;
    queue.end();
    stdoutDone = true;
    finish();
  });
  if (child.stdout === null) {
    queue.end();
    stdoutDone = true;
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrBytes += chunk.length;
    while (stderrBytes > limits.stderrRingBytes && stderrChunks.length > 1) stderrBytes -= stderrChunks.shift()!.length;
    if (options.onStderrLine !== undefined) {
      const text = stderrPartial + chunk.toString("utf8");
      const parts = text.split("\n");
      stderrPartial = (parts.pop() ?? "").slice(-4096);
      for (const l of parts) if (l.trim().length > 0) options.onStderrLine(scrubText(stripAnsi(l), secrets).slice(0, 2000));
    }
  });

  child.stdin?.on("error", () => {
    // EPIPE: the CLI exited before reading all of stdin. The exit code tells the story.
  });
  if (spec.stdin.kind === "text") {
    child.stdin?.end(spec.stdin.text);
  } else if (spec.stdin.kind === "stream-json") {
    child.stdin?.write(spec.stdin.first.endsWith("\n") ? spec.stdin.first : `${spec.stdin.first}\n`);
  }

  child.on("error", (err) => {
    if (closeInfo === null) closeInfo = { code: null, signal: null, error: err };
    queue.end();
    stdoutDone = true;
    finish();
  });
  child.on("close", (code, sig) => {
    if (closeInfo === null) closeInfo = { code, signal: sig, error: null };
    stdoutDone = true;
    queue.end();
    finish();
  });

  const pid = child.pid ?? null;
  const proc: CliProcess = {
    pid,
    lines: queue,
    stats,
    exited,
    get hasExited() {
      return exitedFlag;
    },
    writeLine(line: string): void {
      const s = child.stdin;
      if (s === null || s.destroyed || s.writableEnded) throw new Error("CLI stdin is closed");
      s.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    closeInput(): void {
      const s = child.stdin;
      if (s !== null && !s.writableEnded) s.end();
    },
    signal(sig: "SIGTERM" | "SIGKILL"): void {
      if (pid === null) return;
      if (win) {
        if (!exitedFlag) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        return;
      }
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          if (!exitedFlag) child.kill(sig);
        } catch {
          // already gone
        }
      }
    },
    stderrTail(): string {
      const all = Buffer.concat(stderrChunks).toString("utf8");
      return scrubText(stripAnsi(all), secrets).slice(-limits.stderrTailBytes);
    },
  };
  if (pid !== null) {
    installExitHook();
    LIVE.add(proc);
  }
  return proc;
}

/** Graceful -> forceful: optionally close stdin and wait, then SIGTERM the group, then SIGKILL. */
export async function killProcessGroup(proc: CliProcess, graceful: boolean): Promise<void> {
  if (proc.hasExited) return;
  const done = proc.exited.then(() => true);
  if (graceful) {
    proc.closeInput();
    if (await Promise.race([done, sleep(KILL_TIMING.closeInputGraceMs).then(() => false)])) return;
  }
  proc.signal("SIGTERM");
  if (await Promise.race([done, sleep(KILL_TIMING.termGraceMs).then(() => false)])) return;
  proc.signal("SIGKILL");
  await Promise.race([done, sleep(KILL_TIMING.termGraceMs)]);
}

export function findOnPath(name: string, path: string, delimiter: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

export interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: Error | null;
}

function readHead(path: string, max: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Run a short probe command (version, help, auth status). Bounded output, group-killed on timeout.
 * `captureDir`: write stdout/stderr to files there instead of pipes. Some CLIs exit before a pipe drains (Claude
 * Code's `--help` is cut at 8 KiB on a pipe); a file never loses the tail.
 */
export async function runCommand(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number; maxBytes?: number; stdin?: string; captureDir?: string },
): Promise<CommandResult> {
  const max = options.maxBytes ?? 1 << 20;
  const win = process.platform === "win32";
  let spawnFile = file;
  let spawnArgs = [...args];
  if (win) {
    const r = resolveWindowsShim(file, findOnPath("node.exe", options.env["PATH"] ?? "", ";"));
    spawnFile = r.file;
    spawnArgs = [...r.prefixArgs, ...spawnArgs];
  }
  const files =
    options.captureDir === undefined
      ? null
      : { out: join(options.captureDir, `.probe-${process.pid}-${Date.now()}.out`), err: join(options.captureDir, `.probe-${process.pid}-${Date.now()}.err`) };
  const fds = files === null ? null : { out: openSync(files.out, "wx", 0o600), err: openSync(files.err, "wx", 0o600) };
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(spawnFile, spawnArgs, {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: [options.stdin === undefined ? "ignore" : "pipe", fds === null ? "pipe" : fds.out, fds === null ? "pipe" : fds.err],
        detached: !win,
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      if (fds !== null) {
        closeSync(fds.out);
        closeSync(fds.err);
      }
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, error: e as Error });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      if (win) {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      if (outBytes < max) out.push(c);
      outBytes += c.length;
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (errBytes < max) err.push(c);
      errBytes += c.length;
    });
    child.stdin?.on("error", () => {});
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    const done = (code: number | null, signal: string | null, error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // group already gone
        }
      }
      if (fds !== null && files !== null) {
        closeSync(fds.out);
        closeSync(fds.err);
        resolve({ code, signal, stdout: readHead(files.out, max), stderr: readHead(files.err, max), timedOut, error });
        return;
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8").slice(0, max),
        stderr: Buffer.concat(err).toString("utf8").slice(0, max),
        timedOut,
        error,
      });
    };
    child.on("error", (e) => done(null, null, e));
    child.on("close", (code, signal) => done(code, signal, null));
  });
}

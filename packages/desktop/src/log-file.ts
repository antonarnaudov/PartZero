/**
 * Log files of a bundled build (docs/ALPHA-0-PLAN.md W1; electron-free, unit-tested): `main.log` (the main process)
 * and `agent.log` (the agent utility process and the agent host) in `~/Library/Logs/<productName>` (Electron's
 * `app.getPath("logs")`), so a report (W10 Report Issue) and a coding agent can read what happened.
 *
 * - Every line is scrubbed of key-like strings before it is written (`scrubKeyLike`), like the console lines already are.
 * - Size-rotated: past {@link DEFAULT_MAX_BYTES} the file becomes `.1`, `.1` becomes `.2`, and so on; at most
 *   {@link DEFAULT_KEEP} old files are kept.
 * - Writing never throws: a log that cannot be written (disk full, permissions) turns itself off.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { scrubKeyLike } from "./agent/protocol.js";

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_KEEP = 3;
export type LogLevel = "info" | "warn" | "error";

export class RotatingLog {
  readonly file: string;
  readonly #maxBytes: number;
  readonly #keep: number;
  readonly #now: () => Date;
  #size = -1;
  #broken = false;

  constructor(file: string, options: { maxBytes?: number; keep?: number; now?: () => Date } = {}) {
    this.file = file;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#keep = Math.max(1, options.keep ?? DEFAULT_KEEP);
    this.#now = options.now ?? (() => new Date());
  }

  write(level: LogLevel, message: string): void {
    if (this.#broken) return;
    const lines = scrubKeyLike(message)
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => `${this.#now().toISOString()} ${level.padEnd(5)} ${l}\n`)
      .join("");
    if (lines.length === 0) return;
    try {
      if (this.#size < 0) {
        mkdirSync(dirname(this.file), { recursive: true });
        this.#size = existsSync(this.file) ? statSync(this.file).size : 0;
      }
      if (this.#size > 0 && this.#size + Buffer.byteLength(lines) > this.#maxBytes) this.#rotate();
      appendFileSync(this.file, lines, { encoding: "utf8", mode: 0o600 });
      this.#size += Buffer.byteLength(lines);
    } catch {
      this.#broken = true;
    }
  }

  #rotate(): void {
    rmSync(`${this.file}.${this.#keep}`, { force: true });
    for (let i = this.#keep - 1; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
    this.#size = 0;
  }
}

/** Where a console line goes: the agent's lines (`[aicad-agent] …`) to `agent.log`, everything else to `main.log`. */
export function logFor(line: string): "agent" | "main" {
  return line.startsWith("[aicad-agent]") ? "agent" : "main";
}

/** One printable line from console arguments (strings as they are, errors with their stack, other values as JSON). */
export function formatConsoleArgs(args: readonly unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

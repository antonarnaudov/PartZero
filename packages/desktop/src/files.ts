/**
 * File access policy for the renderer: a path is readable/writable only after the user granted it
 * in a native dialog, or earlier did so (recent files). Recent documents persist in userData.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export class PathGrants {
  private readonly granted = new Set<string>();

  grant(path: string): string {
    const p = resolve(path);
    this.granted.add(p);
    return p;
  }

  has(path: string): boolean {
    return this.granted.has(resolve(path));
  }

  /** Throws unless `path` was granted. */
  check(path: unknown): string {
    if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0")) {
      throw new Error("invalid path");
    }
    const p = resolve(path);
    if (!this.granted.has(p)) throw new Error(`access denied: ${p} was not chosen in a file dialog`);
    return p;
  }
}

/** Documents (not exports) go into the recent list. */
export function isDocumentPath(path: string): boolean {
  return /\.(ts|json)$/i.test(path);
}

export class RecentFiles {
  private items: string[] = [];
  private readonly file: string;
  private readonly max: number;

  constructor(file: string, max = 10) {
    this.file = file;
    this.max = max;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw)) this.items = raw.filter((x): x is string => typeof x === "string").slice(0, max);
    } catch {
      this.items = [];
    }
  }

  list(): string[] {
    return [...this.items];
  }

  add(path: string): void {
    const p = resolve(path);
    this.items = [p, ...this.items.filter((x) => x !== p)].slice(0, this.max);
    this.persist();
  }

  clear(): void {
    this.items = [];
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(this.items, null, 2)}\n`);
    } catch {
      // Best effort.
    }
  }
}

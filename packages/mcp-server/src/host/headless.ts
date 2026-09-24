/**
 * Headless mode of `aicad-mcp` (CLI-PROVIDERS.md §6.7, ARCHITECTURE §9): the design host runs in this
 * process, so any MCP client (Claude Code, Gemini CLI, Codex, opencode, Cursor, an IDE) can work on a
 * CadScript file without the desktop app:
 *
 *   aicad-mcp --doc part.cad.ts [--engine auto|forge|oracle|fixture] [--forge-bin <path>]
 *             [--fixtures <dir>] [--export-dir <dir>] [--scopes ext-read,ext-edit,ext-export]
 *
 * - The document is read once (a regular file of at most {@link MAX_DOC_BYTES}; a FIFO or device is
 *   refused without blocking) and never written. The client's edits land on its `mcp/<client>` branch;
 *   `propose` writes the branch to `<file>.proposal.cad.ts` (replaced on each proposal) for review: a
 *   new temp file (random name, `O_EXCL|O_NOFOLLOW`) renamed over it, so a planted symlink is replaced,
 *   never followed.
 * - Default scopes: `ext-read,ext-edit`, plus `ext-export` when `--export-dir` is given.
 * - Exit codes: 0 after stdin EOF, 2 on a usage error or when no engine is available.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { FixtureEngine, ForgeCliEngine, OracleEngine, type Engine } from "@aicad/evals";
import { serveStreams } from "../mcp.js";
import { DesignHost, type BranchProposal, type ExternalScope } from "./design-host.js";

/** Largest document the headless host reads. */
export const MAX_DOC_BYTES = 4 * 1024 * 1024;

export interface HeadlessIo {
  stdin: Readable;
  stdout: Writable;
  /** Capped diagnostics (stderr). */
  log(line: string): void;
}

export interface HeadlessArgs {
  doc: string;
  engine: "auto" | "forge" | "oracle" | "fixture";
  forgeBin?: string;
  fixtures?: string;
  exportDir?: string;
  scopes: ExternalScope[];
}

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--doc", "--engine", "--forge-bin", "--fixtures", "--export-dir", "--scopes"]);

export function parseHeadlessArgs(argv: readonly string[]): HeadlessArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!VALUE_FLAGS.has(a)) throw new UsageError(`unknown argument ${a.slice(0, 40)}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
    if (flags.has(a)) throw new UsageError(`${a} given twice`);
    flags.set(a, v);
    i++;
  }
  const doc = flags.get("--doc");
  if (!doc) throw new UsageError("--doc <file.cad.ts> is required");
  const engine = flags.get("--engine") ?? "auto";
  if (engine !== "auto" && engine !== "forge" && engine !== "oracle" && engine !== "fixture") throw new UsageError(`unknown engine ${engine} (auto | forge | oracle | fixture)`);
  const exportDir = flags.get("--export-dir");
  let scopes: ExternalScope[];
  const raw = flags.get("--scopes");
  if (raw) {
    scopes = [];
    for (const s of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (s !== "ext-read" && s !== "ext-edit" && s !== "ext-export") throw new UsageError(`unknown scope ${s} (ext-read | ext-edit | ext-export)`);
      scopes.push(s);
    }
    if (scopes.length === 0) throw new UsageError("--scopes is empty");
  } else {
    scopes = ["ext-read", "ext-edit", ...(exportDir ? (["ext-export"] as const) : [])];
  }
  if (scopes.includes("ext-export") && !exportDir) throw new UsageError("the ext-export scope needs --export-dir <dir>");
  const forgeBin = flags.get("--forge-bin");
  const fixtures = flags.get("--fixtures");
  if (engine === "fixture" && !fixtures) throw new UsageError("--engine fixture needs --fixtures <dir>");
  return { doc, engine, scopes, ...(forgeBin ? { forgeBin } : {}), ...(fixtures ? { fixtures } : {}), ...(exportDir ? { exportDir } : {}) };
}

async function makeEngine(a: HeadlessArgs): Promise<Engine> {
  const forge = () => new ForgeCliEngine(a.forgeBin ? { bin: a.forgeBin } : {});
  switch (a.engine) {
    case "forge":
      return forge();
    case "oracle":
      return new OracleEngine();
    case "fixture":
      return new FixtureEngine(a.fixtures!);
    case "auto": {
      const f = forge();
      if ((await f.availability()).available) return f;
      const o = new OracleEngine();
      if ((await o.availability()).available) return o;
      throw new UsageError("no engine available: build the Forge CLI (cargo build -p forge-cli) or pass --forge-bin <path>");
    }
  }
}

/** `part.cad.ts` → `part.proposal.cad.ts`; any other name gets `.proposal.cad.ts` appended. */
export function proposalPath(doc: string): string {
  const abs = resolve(doc);
  const name = basename(abs);
  const stem = name.endsWith(".cad.ts") ? name.slice(0, -".cad.ts".length) : name;
  return join(dirname(abs), `${stem}.proposal.cad.ts`);
}

/** A doc id from the file name: `[A-Za-z0-9_-]{1,64}`. */
export function docIdFor(doc: string): string {
  const stem = basename(doc).replace(/\.cad\.ts$|\.ts$/, "");
  const id = stem.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return id === "" ? "doc" : id;
}

/** Model-written text as `//` comment lines (control characters removed). */
function commentLines(label: string, items: readonly string[]): string[] {
  // eslint-disable-next-line no-control-regex
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, 500);
  return items.length === 0 ? [] : [`// ${label}:`, ...items.map((i) => `//   - ${clean(i)}`)];
}

/**
 * Read the document: `null` when it does not exist (a new document). Opened non-blocking (a FIFO never
 * stalls startup), then it must be a regular file of at most {@link MAX_DOC_BYTES}; the read itself is
 * bounded too, in case the file grows.
 */
export async function readDocument(path: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UsageError(`cannot read ${path}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new UsageError(`${path} is not a regular file`);
    if (st.size > MAX_DOC_BYTES) throw new UsageError(`${path} is larger than ${MAX_DOC_BYTES} bytes`);
    const buf = Buffer.alloc(Math.min(st.size, MAX_DOC_BYTES) + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > MAX_DOC_BYTES) throw new UsageError(`${path} is larger than ${MAX_DOC_BYTES} bytes`);
    if (n > st.size) throw new UsageError(`${path} changed while it was read`);
    return buf.subarray(0, n).toString("utf8");
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`cannot read ${path}`);
  } finally {
    await fh.close();
  }
}

/**
 * Replace `target` with `content`: write a new temp file next to it (random name, created with
 * `O_EXCL|O_NOFOLLOW`, so nothing planted there is followed or reused), then rename it over `target`
 * (rename replaces a symlink at `target`; it never writes through it).
 */
export async function writeProposalFile(target: string, content: string): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(8).toString("hex")}.tmp`);
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    try {
      await fh.writeFile(content, "utf8");
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export function proposalFile(p: BranchProposal): string {
  // eslint-disable-next-line no-control-regex
  const summary = p.proposal.summary.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, 1000);
  const header = [
    `// Proposal from ${p.branch}${p.client ? ` (${p.client.name.replace(/[^\w .@/-]/g, "")} ${p.client.version.replace(/[^\w .-]/g, "")})` : ""}: ${p.verified ? "verified" : "NOT verified"}.`,
    `// Summary: ${summary}`,
    ...commentLines("Assumptions", p.proposal.assumptions),
    ...commentLines("Known issues", p.proposal.known_issues),
    "// Review it, then copy it over the document to accept it.",
    "",
  ];
  return header.join("\n") + p.source;
}

/** Run the headless server until stdin ends. Returns the exit code. */
export async function runHeadless(argv: readonly string[], io: HeadlessIo): Promise<number> {
  let args: HeadlessArgs;
  let engine: Engine;
  let source = "";
  try {
    args = parseHeadlessArgs(argv);
    engine = await makeEngine(args);
    const a = await engine.availability();
    if (!a.available) throw new UsageError(`engine ${engine.kind} is not available: ${a.detail}`);
    source = (await readDocument(args.doc)) ?? ""; // missing: a new document, start empty
  } catch (e) {
    io.log(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const target = proposalPath(args.doc);
  let host: DesignHost;
  try {
    host = await DesignHost.create({
      engine,
      source,
      docId: docIdFor(args.doc),
      scopes: args.scopes,
      ...(args.exportDir ? { exportDir: args.exportDir } : {}),
      proposalDestination: `${basename(target)} next to the document`,
      async onProposal(p) {
        await writeProposalFile(target, proposalFile(p));
        return `Written to ${basename(target)} next to the document.`;
      },
    });
  } catch (e) {
    io.log(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const { done } = serveStreams({ backend: host.backend(), input: io.stdin, output: io.stdout });
  await done;
  return 0;
}

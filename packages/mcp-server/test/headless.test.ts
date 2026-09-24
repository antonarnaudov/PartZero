/**
 * `aicad-mcp --doc <file>`: headless mode, in process (streams) and as the real bin (dist/stdio.js).
 * The engine is a fixture engine recorded from the stub engine, so everything runs offline.
 */
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { DesignSession } from "@aicad/agent-tools";
import { FIXTURE_SCHEMA, irHash, type Engine, type FixtureEntry } from "@aicad/evals";
import { docIdFor, MAX_DOC_BYTES, parseHeadlessArgs, proposalPath, readDocument, runHeadless, writeProposalFile } from "../src/host/headless.js";
import { disc, StubEngine, type EvalReport, type IrDocument } from "./helpers/stub-engine.js";
import { resourceText, SHIM, shortTmp, StreamClientTransport } from "./helpers/util.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const DOC = disc(5, 5);
const CLIENT = "headless-client";

/** Record the stub engine's reports for `sources` (as the branch session will compile them) into a fixture dir. */
async function fixtureDir(root: string, sources: string[]): Promise<string> {
  const entries: FixtureEntry[] = [];
  const stub = new StubEngine();
  const recorder: Engine = {
    kind: "recorder",
    availability: () => stub.availability(),
    async evaluate(ir: IrDocument, o?: { name?: string }): Promise<EvalReport> {
      const report = await stub.evaluate(ir, o);
      entries.push({ label: `e${entries.length}`, ir_sha256: irHash(ir), report });
      return report;
    },
  };
  const s = await DesignSession.open({ engine: recorder, source: sources[0]!, name: CLIENT });
  for (const src of sources.slice(1)) await s.apply(src);
  const dir = join(root, "fixtures");
  mkdirSync(dir);
  writeFileSync(join(dir, "f.json"), JSON.stringify({ schema: FIXTURE_SCHEMA, task: "mcp-headless", engine: "stub 0", entries }));
  return dir;
}

describe("parseHeadlessArgs", () => {
  it("parses flags and defaults the scopes", () => {
    expect(parseHeadlessArgs(["--doc", "a.cad.ts"])).toEqual({ doc: "a.cad.ts", engine: "auto", scopes: ["ext-read", "ext-edit"] });
    expect(parseHeadlessArgs(["--doc", "a.cad.ts", "--export-dir", "out", "--engine", "forge", "--forge-bin", "/x/aicad"])).toEqual({
      doc: "a.cad.ts",
      engine: "forge",
      forgeBin: "/x/aicad",
      exportDir: "out",
      scopes: ["ext-read", "ext-edit", "ext-export"],
    });
    expect(parseHeadlessArgs(["--doc", "a", "--scopes", "ext-read"]).scopes).toEqual(["ext-read"]);
  });

  it("rejects bad usage", () => {
    for (const argv of [[], ["--doc"], ["--doc", "a", "--doc", "b"], ["--doc", "a", "--engine", "occt"], ["--doc", "a", "--scopes", "root"], ["--doc", "a", "--scopes", "ext-export"], ["--doc", "a", "--engine", "fixture"], ["--doc", "a", "--bogus", "1"]]) {
      expect(() => parseHeadlessArgs(argv), argv.join(" ")).toThrow();
    }
  });

  it("derives the proposal path and doc id", () => {
    expect(proposalPath("/w/part.cad.ts")).toBe("/w/part.proposal.cad.ts");
    expect(proposalPath("/w/notes.txt")).toBe("/w/notes.txt.proposal.cad.ts");
    expect(docIdFor("/w/My Part (v2).cad.ts")).toBe("My-Part-v2");
    expect(docIdFor("/w/.cad.ts")).toBe("doc");
  });
});

describe("runHeadless", () => {
  it("serves a document; propose writes <file>.proposal.cad.ts and leaves the document alone", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const doc = join(tmp.dir, "part.cad.ts");
    writeFileSync(doc, DOC);
    const fixtures = await fixtureDir(tmp.dir, [DOC, disc(5, 8)]);
    // A planted symlink at the proposal path is replaced, never written through.
    writeFileSync(join(tmp.dir, "victim.txt"), "keep");
    symlinkSync(join(tmp.dir, "victim.txt"), join(tmp.dir, "part.proposal.cad.ts"));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const logs: string[] = [];
    const exit = runHeadless(["--doc", doc, "--engine", "fixture", "--fixtures", fixtures], { stdin, stdout, log: (l) => logs.push(l) });
    const client = new Client({ name: CLIENT, version: "1.0.0" });
    await client.connect(new StreamClientTransport(stdin, stdout));
    expect(client.getInstructions()).toContain('document "part"');
    expect(client.getInstructions()).toContain("The host writes each proposal to part.proposal.cad.ts next to the document");
    expect(client.getInstructions()).toContain("You have no file access.");
    expect(resourceText((await client.readResource({ uri: "cad://doc/part/code" })).contents[0]!)).toBe(DOC);
    const applied = await client.callTool({ name: "apply_cadscript", arguments: { source: disc(5, 8) } });
    expect(applied.isError).toBe(false);
    const p = await client.callTool({ name: "propose", arguments: { summary: "Plate 8 mm.\nNew line", assumptions: ["*/ not a comment end"], known_issues: [] } });
    expect(p.isError).toBe(false);
    expect((p.content as { text: string }[])[0]!.text).toContain("Written to part.proposal.cad.ts next to the document.");
    const proposal = readFileSync(join(tmp.dir, "part.proposal.cad.ts"), "utf8");
    expect(proposal.startsWith("// Proposal from mcp/headless-client (headless-client 1.0.0): verified.\n// Summary: Plate 8 mm. New line\n")).toBe(true);
    expect(proposal.endsWith(disc(5, 8))).toBe(true);
    expect(readFileSync(doc, "utf8")).toBe(DOC);
    expect(readFileSync(join(tmp.dir, "victim.txt"), "utf8")).toBe("keep");
    expect(lstatSync(join(tmp.dir, "part.proposal.cad.ts")).isFile()).toBe(true);
    expect(readdirSync(tmp.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    await client.close();
    expect(await exit).toBe(0);
    expect(logs).toEqual([]);
  });

  it("exits 2 on usage errors and unavailable engines", async () => {
    const logs: string[] = [];
    const io = { stdin: new PassThrough(), stdout: new PassThrough(), log: (l: string) => logs.push(l) };
    expect(await runHeadless(["--doc"], io)).toBe(2);
    expect(await runHeadless(["--doc", "x.cad.ts", "--engine", "forge", "--forge-bin", "/definitely/missing/aicad"], io)).toBe(2);
    expect(logs[1]).toMatch(/engine forge is not available/);
  });
});

describe("readDocument / writeProposalFile", () => {
  it("reads a regular file; a missing one is a new document", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const doc = join(tmp.dir, "a.cad.ts");
    writeFileSync(doc, DOC);
    expect(await readDocument(doc)).toBe(DOC);
    expect(await readDocument(join(tmp.dir, "missing.cad.ts"))).toBeNull();
  });

  it("refuses FIFOs (without blocking), devices, directories and oversized files", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const fifo = join(tmp.dir, "pipe.cad.ts");
    execFileSync("mkfifo", [fifo]);
    await expect(readDocument(fifo)).rejects.toThrow(/not a regular file/);
    await expect(readDocument("/dev/zero")).rejects.toThrow(/not a regular file/);
    await expect(readDocument(tmp.dir)).rejects.toThrow(/not a regular file/);
    const big = join(tmp.dir, "big.cad.ts");
    const fd = openSync(big, "w");
    ftruncateSync(fd, MAX_DOC_BYTES + 1); // sparse: no disk used
    closeSync(fd);
    await expect(readDocument(big)).rejects.toThrow(/larger than/);
    // Through the CLI entry: exit 2, promptly.
    const logs: string[] = [];
    const fixtures = await fixtureDir(tmp.dir, [DOC]);
    const io = { stdin: new PassThrough(), stdout: new PassThrough(), log: (l: string) => logs.push(l) };
    expect(await runHeadless(["--doc", fifo, "--engine", "fixture", "--fixtures", fixtures], io)).toBe(2);
    expect(logs).toEqual([`${fifo} is not a regular file`]);
  });

  it("writes proposals through a new temp file, never through a planted symlink", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const target = join(tmp.dir, "p.proposal.cad.ts");
    writeFileSync(join(tmp.dir, "victim.txt"), "keep");
    symlinkSync(join(tmp.dir, "victim.txt"), target);
    await writeProposalFile(target, "// one\n");
    expect(readFileSync(join(tmp.dir, "victim.txt"), "utf8")).toBe("keep");
    expect(lstatSync(target).isFile()).toBe(true);
    await writeProposalFile(target, "// two\n");
    expect(readFileSync(target, "utf8")).toBe("// two\n");
    expect(readdirSync(tmp.dir).sort()).toEqual(["p.proposal.cad.ts", "victim.txt"]);
  });
});

describe("aicad-mcp bin, headless", () => {
  it("runs as a real process under the SDK stdio client", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const doc = join(tmp.dir, "part.cad.ts");
    writeFileSync(doc, DOC);
    const out = join(tmp.dir, "out");
    mkdirSync(out);
    const fixtures = await fixtureDir(tmp.dir, [DOC]);
    const transport = new StdioClientTransport({ command: process.execPath, args: [SHIM, "--doc", doc, "--engine", "fixture", "--fixtures", fixtures, "--export-dir", out], stderr: "pipe" });
    const client = new Client({ name: CLIENT, version: "1.0.0" });
    await client.connect(transport);
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("export_design");
    const e = await client.callTool({ name: "export_design", arguments: { format: "cadscript", name: "copy" } });
    expect(e.isError).toBe(false);
    expect(readFileSync(join(out, "copy.cad.ts"), "utf8")).toBe(DOC);
    const m = await client.callTool({ name: "measure", arguments: {} });
    expect(m.isError).toBe(false);
  });
});

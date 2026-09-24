/**
 * The external-client design host, driven by the official SDK client in process (InMemoryTransport).
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closedText, HOST_UNAVAILABLE_TEXT } from "../src/bridge-protocol.js";
import { branchSlug, DesignHost, type BranchProposal, type DesignHostOptions } from "../src/host/design-host.js";
import { exportFileName } from "../src/host/export-dir.js";
import { disc, StubEngine, type EvalReport, type IrDocument } from "./helpers/stub-engine.js";
import { inProcessClient, resourceText, shortTmp, tick } from "./helpers/util.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const DOC = disc(5, 5);

async function host(overrides: Partial<DesignHostOptions> = {}): Promise<{ host: DesignHost; proposals: BranchProposal[] }> {
  const proposals: BranchProposal[] = [];
  const h = await DesignHost.create({
    engine: new StubEngine(),
    source: DOC,
    docId: "bracket",
    scopes: ["ext-read", "ext-edit"],
    onProposal: (p) => {
      proposals.push(p);
      return "Shown in the review panel.";
    },
    ...overrides,
  });
  return { host: h, proposals };
}

async function client(h: DesignHost, name = "claude-code") {
  const c = await inProcessClient(h.backend(), name);
  cleanups.push(c.close);
  return c.client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

/** The stub engine with a delay per evaluation; records when each evaluation ended. */
class SlowEngine extends StubEngine {
  readonly ends: number[] = [];
  readonly #delayMs: number;
  constructor(delayMs: number) {
    super();
    this.#delayMs = delayMs;
  }
  override async evaluate(ir: IrDocument, options: { name?: string } = {}): Promise<EvalReport> {
    await tick(this.#delayMs);
    const report = await super.evaluate(ir, options);
    this.ends.push(Date.now());
    return report;
  }
}

const bridgeCall = (seq: number, name: string, args: Record<string, unknown> = {}) => ({ seq, name, args, toolUseId: null });

describe("DesignHost", () => {
  it("serves the scope's tools and resources, with branch instructions", async () => {
    const { host: h } = await host();
    const c = await client(h);
    expect(c.getServerCapabilities()).toEqual({ tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } });
    expect(c.getInstructions()).toContain("branch mcp/claude-code");
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["apply_cadscript", "checkpoint", "get_code", "ir_summary", "measure", "propose", "rollback", "run_tests"]);
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toEqual(["cad://doc/bracket/code", "cad://doc/bracket/ir-summary", "cad://doc/bracket/spec", "cad://doc/bracket/tests"]);
    expect((await c.listResourceTemplates()).resourceTemplates[0]!.uriTemplate).toBe("cad://doc/{id}/{view}");
    const code = await c.readResource({ uri: "cad://doc/bracket/code" });
    expect(code.contents).toEqual([{ uri: "cad://doc/bracket/code", mimeType: "text/typescript", text: DOC }]);
    const summary = await c.readResource({ uri: "cad://doc/bracket/ir-summary" });
    expect(resourceText(summary.contents[0]!)).toMatch(/2 features/);
    expect(JSON.parse(resourceText((await c.readResource({ uri: "cad://doc/bracket/spec" })).contents[0]!))).toBeNull();
    expect(JSON.parse(resourceText((await c.readResource({ uri: "cad://doc/bracket/tests" })).contents[0]!))).toEqual({ tests: [], results: null });
    await expect(c.readResource({ uri: "cad://doc/other/code" })).rejects.toThrow(/not found/i);
    await expect(c.readResource({ uri: "file:///etc/passwd" })).rejects.toThrow(/not found/i);
  });

  it("puts each client's edits on its own branch and never changes the document", async () => {
    const { host: h, proposals } = await host();
    const a = await client(h, "Claude Code");
    const b = await client(h, "gemini-cli-mcp-client");
    expect(h.branchNames()).toEqual(["mcp/claude-code", "mcp/gemini-cli-mcp-client"]);
    expect((await a.callTool({ name: "apply_cadscript", arguments: { source: disc(5, 9) } })).isError).toBe(false);
    expect(h.branch("mcp/claude-code")!.source).toBe(disc(5, 9));
    expect(h.branch("mcp/gemini-cli-mcp-client")!.source).toBe(DOC);
    expect(text(await b.callTool({ name: "get_code", arguments: {} }))).toContain("distance: 5 }");
    const p = await a.callTool({ name: "propose", arguments: { summary: "Thicker disc.", assumptions: ["9 mm"], known_issues: [] } });
    expect(p.isError).toBe(false);
    expect(text(p)).toBe("Proposal recorded for review on branch mcp/claude-code (model verified). The user's document changes only when they accept it in the app.\nShown in the review panel.");
    expect(proposals).toEqual([
      { branch: "mcp/claude-code", client: { name: "Claude Code", version: "9.9.9" }, source: disc(5, 9), proposal: { summary: "Thicker disc.", assumptions: ["9 mm"], known_issues: [] }, verified: true },
    ]);
    // The branch stays usable after a proposal (the user may reject it).
    expect((await a.callTool({ name: "get_code", arguments: {} })).isError).toBe(false);
    expect(resourceText((await a.readResource({ uri: "cad://doc/bracket/code" })).contents[0]!)).toBe(disc(5, 9));
  });

  it("gives a concurrent same-name client a new branch and a reconnecting client its old one", async () => {
    const { host: h } = await host();
    const c1 = await inProcessClient(h.backend(), "codex-mcp-client");
    const c2 = await inProcessClient(h.backend(), "codex-mcp-client");
    cleanups.push(c2.close);
    expect(h.branchNames()).toEqual(["mcp/codex-mcp-client", "mcp/codex-mcp-client-2"]);
    await c1.client.callTool({ name: "apply_cadscript", arguments: { source: disc(4, 4) } });
    await c1.close();
    const c3 = await client(h, "codex-mcp-client");
    expect(text(await c3.callTool({ name: "get_code", arguments: {} }))).toContain("radius: 4");
    expect(h.branchNames()).toEqual(["mcp/codex-mcp-client", "mcp/codex-mcp-client-2"]);
    expect(branchSlug("  Cursor Agent!! ")).toBe("cursor-agent");
    expect(branchSlug("")).toBe("client");
    expect(branchSlug("../../etc")).toBe("etc");
  });

  it("read-only scope: no edit tools; edits are unknown tools", async () => {
    const { host: h } = await host({ scopes: ["ext-read"] });
    const c = await client(h);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["get_code", "ir_summary", "measure", "run_tests"]);
    const r = await c.callTool({ name: "apply_cadscript", arguments: { source: "" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Unknown tool "apply_cadscript"/);
    expect(c.getInstructions()).toContain("read-only");
  });

  it("stop gating: a gate refuses calls; close() refuses everything with the closed text", async () => {
    let locked = false;
    const { host: h } = await host({ gate: ({ name }) => (locked && name === "apply_cadscript" ? "the user is editing this part" : null) });
    const c = await client(h);
    locked = true;
    const r = await c.callTool({ name: "apply_cadscript", arguments: { source: disc(1, 1) } });
    expect(r).toEqual({ content: [{ type: "text", text: "Refused by the host: the user is editing this part" }], isError: true });
    expect((await c.callTool({ name: "get_code", arguments: {} })).isError).toBe(false);
    h.close("document closed");
    expect(await c.callTool({ name: "get_code", arguments: {} })).toEqual({ content: [{ type: "text", text: closedText("document closed") }], isError: true });
    expect(h.branch("mcp/claude-code")!.applies).toBe(0);
  });

  it("rate limits: calls per minute, calls per session, argument size", async () => {
    let now = 1_000_000;
    const { host: h } = await host({ clock: () => now, limits: { maxCallsPerMinute: 2, maxCalls: 3, maxArgBytes: 200 } });
    const c = await client(h);
    expect((await c.callTool({ name: "get_code", arguments: {} })).isError).toBe(false);
    expect((await c.callTool({ name: "get_code", arguments: {} })).isError).toBe(false);
    const limited = await c.callTool({ name: "get_code", arguments: {} });
    expect(limited.isError).toBe(true);
    expect(text(limited)).toMatch(/rate limit of 2 tool calls per minute/);
    now += 61_000;
    expect((await c.callTool({ name: "get_code", arguments: {} })).isError).toBe(false);
    now += 61_000;
    expect(text(await c.callTool({ name: "get_code", arguments: {} }))).toMatch(/limit of 3 tool calls/);
    const big = await c.callTool({ name: "apply_cadscript", arguments: { source: "x".repeat(300) } });
    expect(text(big)).toMatch(/the limit is 200/);
  });

  it("serializes calls on one branch", async () => {
    const { host: h } = await host();
    const c = await client(h);
    const results = await Promise.all([
      c.callTool({ name: "apply_cadscript", arguments: { source: disc(2, 2) } }),
      c.callTool({ name: "apply_cadscript", arguments: { source: disc(3, 3) } }),
      c.callTool({ name: "get_code", arguments: {} }),
    ]);
    expect(results.map((r) => r.isError)).toEqual([false, false, false]);
    expect(text(results[2])).toContain("radius: 3");
    expect(h.branch("mcp/claude-code")!.applies).toBe(2);
  });

  it("validates options", async () => {
    await expect(DesignHost.create({ engine: new StubEngine(), docId: "../x", scopes: ["ext-read"] })).rejects.toThrow(/doc id/);
    await expect(DesignHost.create({ engine: new StubEngine(), docId: "d", scopes: [] })).rejects.toThrow(/scope/);
    await expect(DesignHost.create({ engine: new StubEngine(), docId: "d", scopes: ["ext-export"] })).rejects.toThrow(/export directory/);
    await expect(DesignHost.create({ engine: new StubEngine(), docId: "d", scopes: ["ext-export"], exportDir: "/definitely/not/here" })).rejects.toThrow(/does not exist/);
  });
});

describe("DesignHost: resources pass the same gates as tool calls", () => {
  const CODE = "cad://doc/bracket/code";

  it("after close() a resource read is refused like a tool call (it used to return the branch source)", async () => {
    const { host: h } = await host();
    const c = await client(h);
    expect(resourceText((await c.readResource({ uri: CODE })).contents[0]!)).toBe(DOC);
    h.close("task ended");
    await expect(c.readResource({ uri: CODE })).rejects.toThrow(/-32003.*The task has ended \(task ended\)/);
    await expect(c.listResources()).rejects.toThrow(/The task has ended \(task ended\)/);
    expect(text(await c.callTool({ name: "get_code", arguments: {} }))).toBe(closedText("task ended"));
  });

  it("an export-only host offers no resources, and its backend refuses them on its own", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const out = join(tmp.dir, "out");
    mkdirSync(out);
    const { host: h } = await host({ scopes: ["ext-export"], exportDir: out });
    expect(h.offersResources).toBe(false);
    const c = await client(h);
    expect(c.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    expect(c.getInstructions()).not.toContain("cad://");
    expect(c.getInstructions()).toContain("This session can only export the design");
    await expect(c.readResource({ uri: CODE })).rejects.toThrow(/-32601|Method not found|does not support/);
    const b = h.backend();
    await b.initialize({ name: "direct", version: "1" });
    await expect(b.resources!.read(CODE)).rejects.toThrow(/no resources/);
  });

  it("gate() sees reads as resources/read; reads count toward the call cap and the per-minute window", async () => {
    let now = 1_000_000;
    let paused = false;
    const seen: string[] = [];
    const { host: h } = await host({
      clock: () => now,
      limits: { maxCallsPerMinute: 3, maxCalls: 5 },
      gate: ({ name }) => {
        seen.push(name);
        return paused && name === "resources/read" ? "reads are paused" : null;
      },
    });
    const c = await client(h);
    await c.readResource({ uri: CODE }); // 1
    paused = true;
    await expect(c.readResource({ uri: CODE })).rejects.toThrow(/Refused by the host: reads are paused/); // refused: not counted
    paused = false;
    await c.callTool({ name: "get_code", arguments: {} }); // 2
    await c.readResource({ uri: CODE }); // 3
    await expect(c.readResource({ uri: CODE })).rejects.toThrow(/rate limit of 3 tool calls per minute/);
    now += 61_000;
    await c.readResource({ uri: CODE }); // 4
    await c.callTool({ name: "get_code", arguments: {} }); // 5
    await expect(c.readResource({ uri: CODE })).rejects.toThrow(/limit of 5 tool calls/);
    expect(text(await c.callTool({ name: "get_code", arguments: {} }))).toMatch(/limit of 5 tool calls/);
    expect(seen.slice(0, 3)).toEqual(["resources/read", "resources/read", "get_code"]);
  });

  it("serializes resource reads with a running tool call on the same branch", async () => {
    const engine = new SlowEngine(60);
    const { host: h } = await host({ engine });
    const c = await client(h);
    const apply = c.callTool({ name: "apply_cadscript", arguments: { source: disc(5, 9) } });
    await tick(10);
    const read = c.readResource({ uri: "cad://doc/bracket/tests" }).then((r) => ({ r, at: Date.now() }));
    const [applied, tests] = await Promise.all([apply, read]);
    expect(applied.isError).toBe(false);
    expect(tests.at).toBeGreaterThanOrEqual(engine.ends.at(-1)!); // it waited for the apply's evaluation
    expect(resourceText((await c.readResource({ uri: CODE })).contents[0]!)).toBe(disc(5, 9));
  });
});

describe("DesignHost: per-request timeouts", () => {
  it("times a request from when it starts on the branch, not from when it was queued", async () => {
    const { host: h } = await host({ engine: new SlowEngine(100), limits: { handlerTimeoutMs: 170 } });
    const c = await client(h);
    // The second apply waits ~100 ms for the first, then runs ~100 ms: 200 ms after it was sent.
    const [a, b] = await Promise.all([
      c.callTool({ name: "apply_cadscript", arguments: { source: disc(2, 2) } }),
      c.callTool({ name: "apply_cadscript", arguments: { source: disc(3, 3) } }),
    ]);
    expect([a.isError, b.isError], `${text(a)} | ${text(b)}`).toEqual([false, false]);
    expect(h.branch("mcp/claude-code")!.applies).toBe(2);
  });

  it("drops a request that waited out the timeout behind a hung one: answered, never run late", async () => {
    const { host: h } = await host({ engine: new SlowEngine(250), limits: { handlerTimeoutMs: 100 } });
    const c = await client(h);
    const first = c.callTool({ name: "apply_cadscript", arguments: { source: disc(2, 2) } });
    await tick(10);
    const second = c.callTool({ name: "apply_cadscript", arguments: { source: disc(3, 3) } });
    expect(text(await first)).toMatch(/^apply_cadscript did not finish within 100 ms; its result is unknown/);
    expect(text(await second)).toMatch(/^Not executed: an earlier request on branch mcp\/claude-code was still running after 100 ms/);
    await tick(350); // the first apply finishes; the dropped one must not start
    expect(h.branch("mcp/claude-code")!.applies).toBe(1);
    expect(h.branch("mcp/claude-code")!.source).toBe(disc(2, 2));
  });
});

describe("DesignHost.handler (desktop bridge)", () => {
  it("keys the branch to the handler, releases it on close(), and retries a failed start", async () => {
    let failSeed = true;
    const { host: h } = await host({
      seed: () => {
        if (failSeed) {
          failSeed = false;
          throw new Error("seed failed");
        }
      },
    });
    const ide = () => ({ name: "Some IDE", version: "1" });
    const first = h.handler(ide);
    expect(await first(bridgeCall(1, "get_code"))).toEqual({ text: "The CAD host could not open a branch for this session; try again.", isError: true });
    expect((await first(bridgeCall(2, "apply_cadscript", { source: disc(4, 4) }))).isError).toBe(false); // not cached: retried
    expect(h.branchNames()).toEqual(["mcp/some-ide"]);
    first.close();
    expect(await first(bridgeCall(3, "get_code"))).toEqual({ text: HOST_UNAVAILABLE_TEXT, isError: true });

    // A later broker whose client reports the same name gets a fresh branch, not the first one's edits.
    const second = h.handler(ide);
    const code = (await second(bridgeCall(1, "get_code"))).text;
    expect(code).toContain("radius: 5");
    expect(code).not.toContain("radius: 4");
    expect(h.branchNames()).toEqual(["mcp/some-ide", "mcp/some-ide-2"]);

    // A stable key hands a branch back on purpose.
    const a = h.handler(ide, { key: "approved-client-1" });
    expect((await a(bridgeCall(1, "apply_cadscript", { source: disc(6, 6) }))).isError).toBe(false);
    a.close();
    const b = h.handler(ide, { key: "approved-client-1" });
    expect((await b(bridgeCall(1, "get_code"))).text).toContain("radius: 6");
    expect(h.branchNames()).toEqual(["mcp/some-ide", "mcp/some-ide-2", "mcp/some-ide-3"]);
  });
});

describe("export directory", () => {
  it("writes new files only inside the export directory", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const out = join(tmp.dir, "out");
    mkdirSync(out);
    const { host: h } = await host({ scopes: ["ext-read", "ext-export"], exportDir: out });
    const c = await client(h);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["export_design", "get_code", "ir_summary", "measure", "run_tests"]);
    const ok = await c.callTool({ name: "export_design", arguments: { format: "cadscript", name: "bracket-v2" } });
    expect(text(ok)).toBe("Exported cadscript to bracket-v2.cad.ts in the export directory.");
    expect(readFileSync(join(out, "bracket-v2.cad.ts"), "utf8")).toBe(DOC);
    expect((await c.callTool({ name: "export_design", arguments: { format: "ir", name: "b.ir.json" } })).isError).toBe(false);
    expect(JSON.parse(readFileSync(join(out, "b.ir.json"), "utf8")).parts[0].name).toBe("p");
    expect((await c.callTool({ name: "export_design", arguments: { format: "report", name: "b" } })).isError).toBe(false);
    expect(existsSync(join(out, "b.metrics.json"))).toBe(true);

    const again = await c.callTool({ name: "export_design", arguments: { format: "cadscript", name: "bracket-v2" } });
    expect(text(again)).toMatch(/already exists/);
    for (const name of ["../escape", "a/b", "/etc/passwd", ".hidden", "..", "x".repeat(70), "a\\b", ""]) {
      const r = await c.callTool({ name: "export_design", arguments: { format: "cadscript", name } });
      expect(r.isError, name).toBe(true);
      expect(text(r)).toMatch(/Invalid file name/);
    }
    expect(existsSync(join(tmp.dir, "escape.cad.ts"))).toBe(false);
    // A planted symlink is never followed.
    writeFileSync(join(tmp.dir, "victim.txt"), "keep");
    symlinkSync(join(tmp.dir, "victim.txt"), join(out, "link.cad.ts"));
    expect(text(await c.callTool({ name: "export_design", arguments: { format: "cadscript", name: "link" } }))).toMatch(/already exists/);
    expect(readFileSync(join(tmp.dir, "victim.txt"), "utf8")).toBe("keep");
    // Without the export scope the tool does not exist.
    const { host: noExport } = await host();
    const c2 = await client(noExport);
    expect(text(await c2.callTool({ name: "export_design", arguments: { format: "cadscript", name: "x" } }))).toMatch(/^Unknown tool/);
  });

  it("file names: bare stems, extension set by the format", () => {
    expect(exportFileName("part", ".cad.ts")).toBe("part.cad.ts");
    expect(exportFileName("part.cad.ts", ".cad.ts")).toBe("part.cad.ts");
    expect(exportFileName("v1.2_final-A", ".ir.json")).toBe("v1.2_final-A.ir.json");
    expect(() => exportFileName("a..b", ".x")).toThrow();
  });
});

describe("DesignHost through the bridge (desktop external mode)", () => {
  it("binds a broker to the connecting client's branch", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { startBroker } = await import("../src/broker.js");
    const { SHIM } = await import("./helpers/util.js");
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const { host: h } = await host();
    let broker: Awaited<ReturnType<typeof startBroker>> | null = null;
    const handler = h.handler(() => broker!.client);
    cleanups.push(() => handler.close());
    broker = await startBroker({ dir: join(tmp.dir, "s"), scope: "ext-edit", tools: h.tools, instructions: h.instructions("mcp/<client>"), handler });
    cleanups.push(() => broker!.dispose());
    const client = new Client({ name: "Some IDE", version: "3.1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SHIM], env: { AICAD_MCP_BRIDGE: broker.endpoint, AICAD_MCP_TICKET: broker.ticket } }));
    cleanups.push(() => client.close());
    expect((await client.callTool({ name: "apply_cadscript", arguments: { source: disc(6, 6) } })).isError).toBe(false);
    expect(broker.client).toEqual({ name: "Some IDE", version: "3.1" });
    expect(h.branchNames()).toEqual(["mcp/some-ide"]);
    expect(h.branch("mcp/some-ide")!.source).toBe(disc(6, 6));
  });
});

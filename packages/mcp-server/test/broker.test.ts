import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { designRegistry, READ_ONLY_TOOLS } from "@aicad/agent-tools";
import { closedText, type BrokerTool } from "../src/bridge-protocol.js";
import { createMcpHost, MAX_QUEUED_CALLS, MAX_RESULT_CHARS, nodeShimCommand, startBroker, type BrokerOptions, type LoggingToolBroker } from "../src/broker.js";
import type { McpCallControl, McpToolCall, McpToolResult } from "../src/types.js";
import { RawBridge, SHIM, shortTmp, tick, until } from "./helpers/util.js";

const tool = (name: string, readOnly = false): BrokerTool => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false },
});

const TOOLS = [tool("apply_cadscript"), tool("get_code", true), tool("propose")];

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Harness {
  broker: LoggingToolBroker;
  calls: McpToolCall[];
  violations: { kind: string; detail: string }[];
  closes: string[];
  dir: string;
}

async function harness(opts: Partial<BrokerOptions> & { respond?: (c: McpToolCall, control: McpCallControl) => Promise<McpToolResult> | McpToolResult } = {}): Promise<Harness> {
  const tmp = shortTmp();
  cleanups.push(tmp.cleanup);
  const calls: McpToolCall[] = [];
  const violations: { kind: string; detail: string }[] = [];
  const closes: string[] = [];
  const dir = join(tmp.dir, "s");
  const broker = await startBroker({
    dir,
    scope: "design",
    tools: TOOLS,
    instructions: "be brief",
    handler: async (c, control) => {
      calls.push(c);
      return opts.respond ? opts.respond(c, control) : { text: `ok ${c.name}`, isError: false };
    },
    onViolation: (v) => violations.push(v),
    onClose: (r) => closes.push(r),
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.orchTag !== undefined ? { orchTag: opts.orchTag } : {}),
    ...(opts.mayWaitForUser !== undefined ? { mayWaitForUser: opts.mayWaitForUser } : {}),
  });
  cleanups.push(() => broker.dispose());
  return { broker, calls, violations, closes, dir };
}

async function connected(h: Harness): Promise<RawBridge> {
  const c = await RawBridge.open(h.broker.endpoint);
  cleanups.push(() => c.close());
  const w = await c.hello(h.broker.ticket);
  expect(w.t).toBe("welcome");
  return c;
}

describe("broker: endpoint and handshake", () => {
  it("listens on a 0600 socket in a 0700 directory and welcomes a valid ticket", async () => {
    const h = await harness();
    expect(h.broker.endpoint).toBe(join(h.dir, "b.sock"));
    expect(statSync(h.dir).mode & 0o777).toBe(0o700);
    expect(statSync(h.broker.endpoint).mode & 0o777).toBe(0o600);
    expect(h.broker.ticket).toMatch(/^[0-9a-f]{64}$/);
    const c = await RawBridge.open(h.broker.endpoint);
    cleanups.push(() => c.close());
    const w = await c.hello(h.broker.ticket, { name: "claude-code", version: "2.1.260" });
    expect(w).toEqual({ t: "welcome", v: 1, scope: "design", server: { name: "cad", version: "0.0.1" }, instructions: "be brief", tools: TOOLS });
    expect(h.broker.stats()).toEqual({ calls: 0, refused: 0, connections: 1, lastCallAt: null });
  });

  it("refuses a socket dir that others can read", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const dir = join(tmp.dir, "open");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await expect(startBroker({ dir, scope: "read", tools: TOOLS, instructions: "", handler: async () => ({ text: "", isError: false }) })).rejects.toThrow(/0700/);
  });

  it("refuses socket paths longer than sun_path allows", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const dir = join(tmp.dir, "x".repeat(90));
    await expect(startBroker({ dir, scope: "read", tools: TOOLS, instructions: "", handler: async () => ({ text: "", isError: false }) })).rejects.toThrow(/longer than/);
  });

  it("denies a wrong ticket, a non-hello first frame and garbage", async () => {
    const h = await harness();
    const a = await RawBridge.open(h.broker.endpoint);
    expect(await a.hello("00".repeat(32))).toEqual({ t: "denied", reason: "bad_ticket" });
    await until(() => a.closed, 2_000, "close after bad ticket");
    const b = await RawBridge.open(h.broker.endpoint);
    expect(await b.hello("short")).toEqual({ t: "denied", reason: "bad_ticket" });
    const c = await RawBridge.open(h.broker.endpoint);
    c.send({ t: "call", id: 1, name: "get_code", args: {}, toolUseId: null });
    await until(() => c.frames.length > 0, 2_000, "denial");
    expect(c.frames[0]).toEqual({ t: "denied", reason: "protocol" });
    const d = await RawBridge.open(h.broker.endpoint);
    d.raw("not json\n");
    await until(() => d.frames.length > 0, 2_000, "denial");
    expect(d.frames[0]).toEqual({ t: "denied", reason: "protocol" });
    expect(h.calls).toEqual([]);
    expect(h.broker.stats().connections).toBe(0);
  });

  it("denies frames over 1 MiB", async () => {
    const h = await harness();
    const c = await connected(h);
    c.raw(JSON.stringify({ t: "call", id: 1, name: "get_code", args: { pad: "x".repeat(1024 * 1024) }, toolUseId: null }) + "\n");
    await until(() => c.closed, 3_000, "close after oversize frame");
    expect(c.frames.at(-1)).toEqual({ t: "denied", reason: "protocol" });
    expect(h.calls).toEqual([]);
  });

  it("allows one active connection and at most maxConnections per ticket", async () => {
    const h = await harness({ limits: { maxConnections: 2 } });
    const a = await connected(h);
    const b = await RawBridge.open(h.broker.endpoint);
    expect(await b.hello(h.broker.ticket)).toEqual({ t: "denied", reason: "too_many_connections" });
    a.close();
    await until(() => a.closed, 2_000, "a closed");
    await tick(20);
    const c = await connected(h); // a restarted server reconnects
    c.close();
    await tick(20);
    const d = await RawBridge.open(h.broker.endpoint);
    expect(await d.hello(h.broker.ticket)).toEqual({ t: "denied", reason: "too_many_connections" });
    expect(h.broker.stats().connections).toBe(2);
  });
});

describe("broker: calls", () => {
  it("runs calls FIFO, one at a time, with seq and toolUseId", async () => {
    let running = 0;
    let maxRunning = 0;
    const h = await harness({
      respond: async (c) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await tick(c.name === "apply_cadscript" ? 30 : 5);
        running--;
        return { text: `done ${c.seq}`, isError: false };
      },
    });
    const c = await connected(h);
    c.send({ t: "call", id: 1, name: "apply_cadscript", args: { source: "a" }, toolUseId: "toolu_a" });
    c.send({ t: "call", id: 2, name: "get_code", args: {}, toolUseId: null });
    c.send({ t: "call", id: 3, name: "get_code", args: { feature: "x" }, toolUseId: "toolu_c" });
    expect(await c.result(3)).toEqual({ text: "done 3", isError: false });
    expect(maxRunning).toBe(1);
    expect(h.calls.map((x) => [x.seq, x.name, x.toolUseId])).toEqual([
      [1, "apply_cadscript", "toolu_a"],
      [2, "get_code", null],
      [3, "get_code", "toolu_c"],
    ]);
    const results = c.frames.filter((f) => f.t === "result").map((f) => (f.t === "result" ? f.id : 0));
    expect(results).toEqual([1, 2, 3]);
    expect(h.broker.log().map((l) => ({ seq: l.seq, name: l.name, refused: l.refused, text: l.text }))).toEqual([
      { seq: 1, name: "apply_cadscript", refused: false, text: "done 1" },
      { seq: 2, name: "get_code", refused: false, text: "done 2" },
      { seq: 3, name: "get_code", refused: false, text: "done 3" },
    ]);
    expect(h.broker.stats()).toMatchObject({ calls: 3, refused: 0 });
  });

  it("refuses unknown tools and oversized arguments without running the handler", async () => {
    const h = await harness({ limits: { maxArgBytes: 64 } });
    const c = await connected(h);
    const u = await c.call(1, "Bash", { command: "ls" });
    expect(u.isError).toBe(true);
    expect(u.text).toBe('Unknown tool "Bash". Available: apply_cadscript, get_code, propose.');
    const big = await c.call(2, "apply_cadscript", { source: "x".repeat(100) });
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/limit is 64/);
    expect(h.calls).toEqual([]);
    expect(h.violations.map((v) => v.kind)).toEqual(["unknown_tool", "arg_size"]);
    expect(h.broker.stats()).toMatchObject({ calls: 0, refused: 2 });
    expect(h.broker.state).toBe("open");
  });

  it("clips result text at 16 KiB", async () => {
    const h = await harness({ respond: () => ({ text: "y".repeat(40_000), isError: false }) });
    const c = await connected(h);
    const r = await c.call(1, "get_code");
    expect(r.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(r.text.endsWith("[clipped at 16384 chars]")).toBe(true);
  });

  it("turns a throwing handler into an isError result", async () => {
    const h = await harness({
      respond: () => {
        throw new Error("secret detail");
      },
    });
    const c = await connected(h);
    const r = await c.call(1, "get_code");
    expect(r).toEqual({ text: "get_code failed in the CAD host.", isError: true });
  });
});

describe("broker: stop gating", () => {
  it("closes after delivering a result with `close`, then refuses every call with the closed text", async () => {
    const h = await harness({ respond: (c) => (c.name === "propose" ? { text: "Proposal recorded.", isError: false, close: "proposed" } : { text: "ok", isError: false }) });
    const c = await connected(h);
    expect(await c.call(1, "propose")).toEqual({ text: "Proposal recorded.", isError: false });
    await until(() => c.frames.some((f) => f.t === "closed"), 2_000, "closed frame");
    expect(c.frames.find((f) => f.t === "closed")).toEqual({ t: "closed", reason: "proposed", text: closedText("proposed") });
    expect(h.broker.state).toBe("closing");
    expect(h.closes).toEqual(["proposed"]);
    expect(await c.call(2, "get_code")).toEqual({ text: closedText("proposed"), isError: true });
    expect(h.violations).toEqual([]);
    expect(await c.call(3, "get_code")).toEqual({ text: closedText("proposed"), isError: true });
    expect(h.violations).toEqual([{ kind: "after_close_limit", detail: "2 calls after close (proposed)" }]);
    expect(h.calls.map((x) => x.name)).toEqual(["propose"]);
    expect(h.broker.stats()).toMatchObject({ calls: 1, refused: 2 });
  });

  it("refuses queued calls once an earlier call closed the broker", async () => {
    const h = await harness({
      respond: async (c) => {
        await tick(20);
        return c.name === "apply_cadscript" ? { text: "same error again", isError: true, close: "same_error" } : { text: "ok", isError: false };
      },
    });
    const c = await connected(h);
    c.send({ t: "call", id: 1, name: "apply_cadscript", args: {}, toolUseId: null });
    c.send({ t: "call", id: 2, name: "get_code", args: {}, toolUseId: null });
    expect(await c.result(1)).toEqual({ text: "same error again", isError: true });
    expect(await c.result(2)).toEqual({ text: closedText("same_error"), isError: true });
    expect(h.calls.length).toBe(1);
  });

  it("host close(): refuses calls, and ends connections after the grace period", async () => {
    const h = await harness({ limits: { closeGraceMs: 50 } });
    const c = await connected(h);
    h.broker.close("cancelled");
    h.broker.close("ignored second reason");
    expect(await c.call(1, "get_code")).toEqual({ text: closedText("cancelled"), isError: true });
    await until(() => c.closed, 2_000, "connection ended after grace");
    expect(h.broker.state).toBe("closed");
    const late = await RawBridge.open(h.broker.endpoint).catch(() => null);
    if (late) {
      await tick(50);
      expect(late.frames.filter((f) => f.t === "welcome")).toEqual([]);
      late.close();
    }
  });

  it("enforces the call limit, then closes", async () => {
    const h = await harness({ limits: { maxCalls: 2 } });
    const c = await connected(h);
    await c.call(1, "get_code");
    await c.call(2, "get_code");
    expect(await c.call(3, "get_code")).toEqual({ text: closedText("call_limit"), isError: true });
    expect(h.violations.map((v) => v.kind)).toEqual(["call_limit"]);
    expect(h.closes).toEqual(["call_limit"]);
    expect(h.calls.length).toBe(2);
  });

  it("times out a hung handler, closes, and never starts another handler", async () => {
    let release!: () => void;
    const h = await harness({
      limits: { handlerTimeoutMs: 40 },
      respond: (c) => (c.name === "apply_cadscript" ? new Promise((r) => (release = () => r({ text: "late", isError: false }))) : { text: "ok", isError: false }),
    });
    const c = await connected(h);
    expect(await c.call(1, "apply_cadscript")).toEqual({ text: closedText("handler_timeout"), isError: true });
    expect(h.violations.map((v) => v.kind)).toEqual(["handler_timeout"]);
    expect(await c.call(2, "get_code")).toEqual({ text: closedText("handler_timeout"), isError: true });
    release();
    expect(h.calls.map((x) => x.name)).toEqual(["apply_cadscript"]);
  });

  it("drops queued calls of a disconnected client and cancels a queued call on request", async () => {
    const h = await harness({
      respond: async () => {
        await tick(40);
        return { text: "ok", isError: false };
      },
    });
    const c = await connected(h);
    c.send({ t: "call", id: 1, name: "get_code", args: {}, toolUseId: null });
    c.send({ t: "call", id: 2, name: "get_code", args: {}, toolUseId: null });
    c.send({ t: "cancel", id: 2 });
    expect(await c.result(2)).toEqual({ text: "Cancelled by the client before it ran.", isError: true });
    c.send({ t: "call", id: 3, name: "get_code", args: {}, toolUseId: null });
    await tick(5);
    c.close();
    await tick(120);
    expect(h.calls.length).toBe(1); // call 3 was queued behind call 1 and dropped
  });

  it("dispose() unlinks the socket", async () => {
    const h = await harness();
    expect(existsSync(h.broker.endpoint)).toBe(true);
    await h.broker.dispose();
    await h.broker.dispose();
    expect(existsSync(h.broker.endpoint)).toBe(false);
    expect(h.broker.state).toBe("closed");
  });
});

describe("broker: queue and refusal limits", () => {
  it("refuses a call at once when MAX_QUEUED_CALLS are already waiting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await harness({
      respond: async (c) => {
        if (c.seq === 1) await gate;
        return { text: `ok ${c.seq}`, isError: false };
      },
    });
    const c = await connected(h);
    c.send({ t: "call", id: 0, name: "apply_cadscript", args: {}, toolUseId: null }); // running
    await until(() => h.calls.length === 1, 2_000, "first call running");
    for (let i = 1; i <= MAX_QUEUED_CALLS; i++) c.send({ t: "call", id: i, name: "get_code", args: {}, toolUseId: null });
    const over = await c.call(99, "get_code"); // answered while the first call still runs
    expect(over).toEqual({ text: `Not executed: ${MAX_QUEUED_CALLS} calls are already waiting. Wait for their results before calling again.`, isError: true });
    expect(h.violations).toEqual([{ kind: "queue_full", detail: `get_code: ${MAX_QUEUED_CALLS} calls waiting` }]);
    expect(h.calls.length).toBe(1);
    release();
    for (let i = 1; i <= MAX_QUEUED_CALLS; i++) expect((await c.result(i)).isError).toBe(false); // every queued call ran
    expect(h.broker.stats()).toMatchObject({ calls: MAX_QUEUED_CALLS + 1, refused: 1 });
    expect(h.broker.state).toBe("open");
  });

  it("counts refused calls toward maxCalls and closes when a model loops on them", async () => {
    const h = await harness({ limits: { maxCalls: 3, maxArgBytes: 64 } });
    const c = await connected(h);
    expect((await c.call(1, "Bash", { command: "ls" })).text).toMatch(/^Unknown tool "Bash"/);
    expect((await c.call(2, "get_code")).text).toBe("ok get_code");
    expect((await c.call(3, "apply_cadscript", { source: "x".repeat(100) })).text).toMatch(/limit is 64/);
    expect(await c.call(4, "Bash")).toEqual({ text: closedText("call_limit"), isError: true });
    expect(h.violations.map((v) => v.kind)).toEqual(["unknown_tool", "arg_size", "call_limit"]);
    expect(h.violations.at(-1)!.detail).toBe("1 calls, 2 refused");
    expect(h.closes).toEqual(["call_limit"]);
    expect(h.calls.length).toBe(1);
  });
});

describe("broker: after-close counting", () => {
  it("answers calls queued before close with the closed text but does not count them", async () => {
    const h = await harness({
      respond: async (c) => {
        await tick(20);
        return c.name === "propose" ? { text: "Proposal recorded.", isError: false, close: "proposed" } : { text: "ok", isError: false };
      },
    });
    const c = await connected(h);
    // A CLI that issues parallel calls: propose plus two reads, all sent before any result.
    c.send({ t: "call", id: 1, name: "propose", args: {}, toolUseId: null });
    c.send({ t: "call", id: 2, name: "get_code", args: {}, toolUseId: null });
    c.send({ t: "call", id: 3, name: "get_code", args: {}, toolUseId: null });
    expect(await c.result(1)).toEqual({ text: "Proposal recorded.", isError: false });
    expect(await c.result(2)).toEqual({ text: closedText("proposed"), isError: true });
    expect(await c.result(3)).toEqual({ text: closedText("proposed"), isError: true });
    expect(h.violations).toEqual([]);
    // Calls the model sends after it saw the closed text do count.
    await c.call(4, "get_code");
    expect(h.violations).toEqual([]);
    await c.call(5, "get_code");
    expect(h.violations).toEqual([{ kind: "after_close_limit", detail: "2 calls after close (proposed)" }]);
    expect(h.calls.map((x) => x.name)).toEqual(["propose"]);
  });
});

describe("broker: user waits and the handler deadline", () => {
  it("does not time out a non-ask_user call while its handler waits for the user (control.userWait)", async () => {
    const h = await harness({
      limits: { handlerTimeoutMs: 60 },
      respond: async (c, control) => {
        // The 80 % budget checkpoint asks the user during apply_cadscript: 150 ms > handlerTimeoutMs.
        const answer = await control.userWait(tick(150).then(() => "continue"));
        await tick(20);
        return { text: `${c.name} after ${answer}`, isError: false };
      },
    });
    const c = await connected(h);
    expect(await c.call(1, "apply_cadscript")).toEqual({ text: "apply_cadscript after continue", isError: false });
    expect(h.violations).toEqual([]);
    expect(h.broker.state).toBe("open");
  });

  it("still times out the handler's own time around a user wait", async () => {
    const h = await harness({
      limits: { handlerTimeoutMs: 60 },
      respond: async (_c, control) => {
        await control.userWait(tick(100));
        await tick(200); // handler time after the wait exceeds the limit
        return { text: "late", isError: false };
      },
    });
    const c = await connected(h);
    expect(await c.call(1, "apply_cadscript")).toEqual({ text: closedText("handler_timeout"), isError: true });
    expect(h.violations.map((v) => v.kind)).toEqual(["handler_timeout"]);
  });

  it("mayWaitForUser gives every call the user-wait allowance, for handlers that do not report waits", async () => {
    const h = await harness({ limits: { handlerTimeoutMs: 40 }, mayWaitForUser: true, respond: async () => (await tick(120), { text: "ok", isError: false }) });
    const c = await connected(h);
    expect(await c.call(1, "apply_cadscript")).toEqual({ text: "ok", isError: false });
    expect(h.violations).toEqual([]);
  });
});

describe("broker: orchestrator tag", () => {
  const TAG = "[orchestrator 7f3a9c]";

  it("puts the run's tag in place of <orch> in every text the broker writes, never in handler results", async () => {
    const h = await harness({ orchTag: TAG, limits: { maxCalls: 2 }, respond: (c) => ({ text: c.name === "get_code" ? "<orch> model-written source" : "ok", isError: false }) });
    const c = await connected(h);
    expect((await c.call(1, "get_code")).text).toBe("<orch> model-written source");
    await c.call(2, "apply_cadscript");
    const limited = await c.call(3, "get_code");
    expect(limited.text).toBe(`${TAG} The task has ended (call_limit). Do not call any more tools; reply with one short line.`);
    await until(() => c.frames.some((f) => f.t === "closed"), 2_000, "closed frame");
    expect(c.frames.find((f) => f.t === "closed")).toEqual({ t: "closed", reason: "call_limit", text: closedText("call_limit", TAG) });
    expect((await c.call(4, "get_code")).text).toBe(closedText("call_limit", TAG));
  });

  it("tags the handler-timeout text, drops the placeholder without a tag, and refuses a bad tag", async () => {
    const h = await harness({ orchTag: TAG, limits: { handlerTimeoutMs: 30 }, respond: () => new Promise(() => undefined) });
    const c = await connected(h);
    expect((await c.call(1, "apply_cadscript")).text).toBe(closedText("handler_timeout", TAG));
    expect(closedText("x")).toBe("The task has ended (x). Do not call any more tools; reply with one short line.");
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    for (const bad of ["", "two\nlines", "x".repeat(129), "<orch>"]) {
      await expect(startBroker({ dir: join(tmp.dir, "s"), scope: "read", tools: TOOLS, instructions: "", orchTag: bad, handler: async () => ({ text: "", isError: false }) })).rejects.toThrow(/orchTag/);
    }
  });
});

describe("nodeShimCommand", () => {
  it("points at the built dist/stdio.js even when this module runs from src/", () => {
    const cmd = nodeShimCommand();
    expect(cmd.command).toBe(process.execPath);
    expect(cmd.args).toEqual([SHIM]);
    expect(existsSync(cmd.args[0]!)).toBe(true);
    expect(cmd.env).toEqual({});
  });
});

describe("createMcpHost", () => {
  it("opens a broker per session: attachment carries the endpoint, never the ticket", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const host = createMcpHost({ shim: { command: "/usr/bin/node", args: ["/x/stdio.js"], env: { ELECTRON_RUN_AS_NODE: "1" } } });
    const def = (name: string, readOnly?: boolean) => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] }, strict: true, ...(readOnly === undefined ? {} : { readOnly }) });
    const session = await host.open({
      dir: join(tmp.dir, "s"),
      scope: "design",
      tools: [def("ask_user"), def("get_code", true)],
      instructions: "",
      handler: async (c) => ({ text: `hi ${c.name}`, isError: false }),
    });
    cleanups.push(() => session.dispose());
    const a = session.attachment;
    expect(a.serverName).toBe("cad");
    expect(a.command).toBe("/usr/bin/node");
    expect(a.args).toEqual(["/x/stdio.js"]);
    expect(a.env).toEqual({ ELECTRON_RUN_AS_NODE: "1", AICAD_MCP_BRIDGE: join(tmp.dir, "s", "b.sock") });
    expect(JSON.stringify(a)).not.toContain(session.ticket);
    expect(a.ticketEnv).toBe("AICAD_MCP_TICKET");
    expect(a.toolNames).toEqual(["ask_user", "get_code"]);
    expect(a.callTimeoutMs).toBe(900_000);
    const c = await RawBridge.open(a.env["AICAD_MCP_BRIDGE"]!);
    cleanups.push(() => c.close());
    const w = await c.hello(session.ticket);
    expect(w.t === "welcome" ? w.tools.map((t) => [t.name, t.annotations.readOnlyHint]) : null).toEqual([
      ["ask_user", false],
      ["get_code", true],
    ]);
    expect(await c.call(1, "get_code")).toEqual({ text: "hi get_code", isError: false });
    expect(session.log()).toEqual([{ seq: 1, name: "get_code", isError: false, ms: expect.any(Number), text: "hi get_code" }]);
    session.close("done");
    expect(session.state).toBe("closing");
  });

  it("uses the submit limits for the submit scope and refuses a ticket in the shim env", async () => {
    expect(() => createMcpHost({ shim: { command: "n", args: [], env: { AICAD_MCP_TICKET: "x" } } })).toThrow(/AICAD_MCP_TICKET/);
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const host = createMcpHost({ shim: { command: "n", args: [], env: {} } });
    const session = await host.open({
      dir: join(tmp.dir, "s"),
      scope: "submit",
      tools: [{ name: "submit_turn", description: "envelope", inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] } }],
      instructions: "",
      handler: async () => ({ text: "Invalid envelope", isError: true }),
    });
    cleanups.push(() => session.dispose());
    expect(session.attachment.callTimeoutMs).toBe(150_000);
    const c = await RawBridge.open(session.attachment.env["AICAD_MCP_BRIDGE"]!);
    cleanups.push(() => c.close());
    await c.hello(session.ticket);
    for (let i = 1; i <= 4; i++) expect((await c.call(i, "submit_turn")).text).toBe("Invalid envelope");
    expect((await c.call(5, "submit_turn")).text).toBe(closedText("call_limit"));
  });

  it("passes orchTag and mayWaitForUser through; any call may then wait for the user", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const host = createMcpHost({ shim: { command: "n", args: [], env: {} } });
    const session = await host.open({
      dir: join(tmp.dir, "s"),
      scope: "design",
      tools: [{ name: "apply_cadscript", description: "d", inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] } }],
      instructions: "",
      limits: { handlerTimeoutMs: 40 },
      orchTag: "[orchestrator abc]",
      mayWaitForUser: true,
      handler: async (_c, control) => {
        await control.userWait(tick(100));
        return { text: "applied", isError: false, close: "stop" };
      },
    });
    cleanups.push(() => session.dispose());
    expect(session.attachment.callTimeoutMs).toBe(900_000);
    const c = await RawBridge.open(session.attachment.env["AICAD_MCP_BRIDGE"]!);
    cleanups.push(() => c.close());
    await c.hello(session.ticket);
    expect(await c.call(1, "apply_cadscript")).toEqual({ text: "applied", isError: false });
    expect((await c.call(2, "apply_cadscript")).text).toBe(closedText("stop", "[orchestrator abc]"));
  });

  it("fills readOnly from READ_ONLY_TOOLS for registry.defs(), and refuses a read scope with a writing tool", async () => {
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const host = createMcpHost({ shim: { command: "n", args: [], env: {} } });
    const registry = designRegistry();
    const session = await host.open({ dir: join(tmp.dir, "a"), scope: "design", tools: registry.defs(), instructions: "", handler: async () => ({ text: "", isError: false }) });
    cleanups.push(() => session.dispose());
    const c = await RawBridge.open(session.attachment.env["AICAD_MCP_BRIDGE"]!);
    cleanups.push(() => c.close());
    const w = await c.hello(session.ticket);
    const hints = w.t === "welcome" ? Object.fromEntries(w.tools.map((t) => [t.name, t.annotations.readOnlyHint])) : {};
    for (const n of registry.names()) expect(hints[n], n).toBe(registry.get(n)!.readOnly === true);
    expect(Object.entries(hints).filter(([, ro]) => ro).map(([n]) => n).sort()).toEqual([...READ_ONLY_TOOLS].sort());
    await expect(
      host.open({ dir: join(tmp.dir, "b"), scope: "read", tools: registry.subset(["get_code", "apply_cadscript"]).defs(), instructions: "", handler: async () => ({ text: "", isError: false }) }),
    ).rejects.toThrow(/read-only tools only; not read-only: apply_cadscript/);
    await expect(
      host.open({ dir: join(tmp.dir, "c"), scope: "ext-read", tools: [{ ...registry.subset(["get_code"]).defs()[0]!, readOnly: false }], instructions: "", handler: async () => ({ text: "", isError: false }) }),
    ).rejects.toThrow(/not read-only: get_code/);
  });
});

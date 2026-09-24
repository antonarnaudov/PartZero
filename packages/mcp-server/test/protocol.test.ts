import { describe, expect, it } from "vitest";
import {
  BROKER_CLOSED_TEXT,
  closedText,
  encodeFrame,
  isOrchTag,
  isTicketShape,
  MAX_BRIDGE_FRAME_BYTES,
  parseClientMsg,
  parseHostMsg,
  withOrchTag,
  type BridgeClientMsg,
  type BridgeHostMsg,
} from "../src/bridge-protocol.js";
import { classify, LineSplitter, MAX_FRAME_BYTES } from "../src/jsonrpc.js";

describe("jsonrpc classify", () => {
  it("classifies requests, notifications and responses", () => {
    expect(classify('{"jsonrpc":"2.0","id":1,"method":"ping"}')).toEqual({ kind: "request", msg: { jsonrpc: "2.0", id: 1, method: "ping" } });
    expect(classify('{"jsonrpc":"2.0","id":"a","method":"tools/list","params":{}}').kind).toBe("request");
    expect(classify('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toEqual({ kind: "notification", msg: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(classify('{"jsonrpc":"2.0","id":3,"result":{}}').kind).toBe("response");
  });

  it("answers malformed frames with the JSON-RPC error codes", () => {
    expect(classify("{nope")).toMatchObject({ kind: "invalid", id: null, code: -32700 });
    expect(classify('[{"jsonrpc":"2.0","id":1,"method":"ping"}]')).toMatchObject({ kind: "invalid", id: null, code: -32600 });
    expect(classify('{"id":1,"method":"ping"}')).toMatchObject({ kind: "invalid", id: 1, code: -32600 });
    expect(classify('{"jsonrpc":"2.0","id":2,"method":"x","params":[1]}')).toMatchObject({ kind: "invalid", id: 2, code: -32602 });
    expect(classify('{"jsonrpc":"2.0","id":{"a":1},"method":"x"}')).toMatchObject({ kind: "invalid", id: null, code: -32600 });
    expect(classify('"str"')).toMatchObject({ kind: "invalid", code: -32600 });
  });
});

describe("LineSplitter", () => {
  it("splits across chunks, accepts CRLF and skips blank lines", () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l), () => lines.push("<oversize>"));
    s.push('{"a":');
    s.push("1}\r\n\n{");
    s.push(Buffer.from('"b":"é"}\n'));
    s.push("tail");
    s.end();
    expect(lines).toEqual(['{"a":1}', '{"b":"é"}', "tail"]);
  });

  it("drops an over-long line as it streams in and keeps going", () => {
    const lines: string[] = [];
    let oversize = 0;
    const s = new LineSplitter((l) => lines.push(l), () => oversize++, 16);
    s.push("0123456789");
    s.push("0123456789");
    s.push("0123456789\nok\n");
    s.push("x".repeat(16) + "\n");
    expect(oversize).toBe(1);
    expect(lines).toEqual(["ok", "x".repeat(16)]);
  });

  it("uses a 1 MiB default frame limit", () => {
    let oversize = 0;
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l), () => oversize++);
    s.push("a".repeat(MAX_FRAME_BYTES) + "\n");
    s.push("a".repeat(MAX_FRAME_BYTES + 1) + "\n");
    expect(lines.length).toBe(1);
    expect(oversize).toBe(1);
  });
});

describe("bridge protocol", () => {
  const ticket = "ab".repeat(32);
  const client: BridgeClientMsg[] = [
    { t: "hello", v: 1, ticket, pid: 42, client: { name: "claude-code", version: "2.1.260" } },
    { t: "hello", v: 1, ticket, pid: 42, client: null },
    { t: "call", id: 7, name: "apply_cadscript", args: { source: "x" }, toolUseId: "toolu_1" },
    { t: "call", id: 0, name: "get_code", args: {}, toolUseId: null },
    { t: "cancel", id: 7 },
    { t: "bye" },
  ];
  const host: BridgeHostMsg[] = [
    {
      t: "welcome",
      v: 1,
      scope: "design",
      server: { name: "cad", version: "0.0.1" },
      instructions: "hi",
      tools: [{ name: "get_code", description: "d", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }],
    },
    { t: "result", id: 7, text: "ok", isError: false },
    { t: "closed", reason: "proposed" },
    { t: "closed", reason: "proposed", text: "[orchestrator ab12] The task has ended (proposed)." },
    { t: "denied", reason: "bad_ticket" },
  ];

  it("round-trips every frame type", () => {
    for (const m of client) expect(parseClientMsg(encodeFrame(m).trimEnd())).toEqual({ ok: true, msg: m });
    for (const m of host) expect(parseHostMsg(encodeFrame(m).trimEnd())).toEqual({ ok: true, msg: m });
    expect(isTicketShape(ticket)).toBe(true);
    expect(isTicketShape("AB".repeat(32))).toBe(false);
  });

  it("rejects extra keys, wrong versions and bad fields", () => {
    const bad = [
      { t: "hello", v: 2, ticket, pid: 1, client: null },
      { t: "hello", v: 1, ticket, pid: 1, client: null, extra: 1 },
      { t: "hello", v: 1, ticket, pid: -1, client: null },
      { t: "call", id: 1.5, name: "x", args: {}, toolUseId: null },
      { t: "call", id: 1, name: "../x", args: {}, toolUseId: null },
      { t: "call", id: 1, name: "x", args: [], toolUseId: null },
      { t: "call", id: 1, name: "x", args: {}, toolUseId: 5 },
      { t: "cancel" },
      { t: "bye", x: 1 },
      { t: "welcome" },
      { t: "nope" },
    ];
    for (const b of bad) expect(parseClientMsg(JSON.stringify(b)).ok).toBe(false);
    expect(parseHostMsg(JSON.stringify({ t: "denied", reason: "whatever" })).ok).toBe(false);
    expect(parseHostMsg(JSON.stringify({ t: "closed", reason: "x", text: 5 })).ok).toBe(false);
    expect(parseHostMsg(JSON.stringify({ t: "closed", reason: "x", text: "y".repeat(1025) })).ok).toBe(false);
    expect(parseHostMsg(JSON.stringify({ ...host[0], server: { name: "other", version: "1" } })).ok).toBe(false);
    expect(parseClientMsg("x".repeat(MAX_BRIDGE_FRAME_BYTES + 1))).toEqual({ ok: false, error: "frame too large" });
  });

  it("never throws on fuzzed frames (seeded mutations)", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = '{}[]":,0123456789-.eE tfnaluhlroyid\\u\n\t\x00';
    const bases = [...client, ...host].map((m) => JSON.stringify(m));
    for (let i = 0; i < 4000; i++) {
      const base = bases[Math.floor(rand() * bases.length)]!;
      const chars = [...base];
      const edits = 1 + Math.floor(rand() * 4);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rand() * (chars.length + 1));
        const op = rand();
        const c = alphabet[Math.floor(rand() * alphabet.length)]!;
        if (op < 0.4) chars.splice(at, 1);
        else if (op < 0.8) chars.splice(at, 0, c);
        else chars[at] = c;
      }
      const line = chars.join("");
      const a = parseClientMsg(line);
      const b = parseHostMsg(line);
      for (const r of [a, b]) {
        if (r.ok) {
          // Anything accepted re-encodes to a frame that parses to the same message.
          const again = r === a ? parseClientMsg(JSON.stringify(r.msg)) : parseHostMsg(JSON.stringify(r.msg));
          expect(again).toEqual(r);
        } else {
          expect(typeof r.error).toBe("string");
        }
      }
    }
  });
});

describe("orchestrator tag", () => {
  it("replaces <orch> with the run's tag, or drops it (and its space) without one", () => {
    const tag = "[orchestrator 9f2c]";
    expect(closedText("proposed", tag)).toBe(BROKER_CLOSED_TEXT("proposed").replace("<orch>", tag));
    expect(closedText("proposed")).toBe("The task has ended (proposed). Do not call any more tools; reply with one short line.");
    expect(withOrchTag("<orch> a <orch>", tag)).toBe(`${tag} a ${tag}`);
    expect(withOrchTag("<orch>x", null)).toBe("x");
    expect(withOrchTag("no placeholder", tag)).toBe("no placeholder");
    expect(isOrchTag(tag)).toBe(true);
    for (const bad of ["", "a\nb", "a\u2028b", "x".repeat(129), "<orch>"]) expect(isOrchTag(bad), JSON.stringify(bad)).toBe(false);
  });
});

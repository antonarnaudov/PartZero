/**
 * The worker RPC keeps a command refusal's machine-readable fields across the worker boundary
 * (the forge-web worker runs the IR v1 command layer): `code`, `errors` and `details` reach the
 * caller, which turns them back into a `CommandEngineError`.
 */
import { describe, expect, it } from "vitest";
import { CommandEngineError, toCommandEngineError } from "../src/doc/v1/command-engine";
import { serveRpc, WorkerRpc, type RpcError } from "../src/worker-rpc";

type Listener = (e: { data: unknown }) => void;

/**
 * A worker and its `self`, connected in memory: messages are cloned when posted (a value that does
 * not clone throws from `postMessage`, as a real port's `DataCloneError` does) and delivered
 * asynchronously.
 */
function pair(): { worker: Worker; port: unknown } {
  const workerListeners = new Map<string, Listener[]>();
  const portListeners = new Map<string, Listener[]>();
  const on = (m: Map<string, Listener[]>) => (type: string, l: Listener) => m.set(type, [...(m.get(type) ?? []), l]);
  const deliver = (m: Map<string, Listener[]>, data: unknown) => {
    const cloned = structuredClone(data);
    queueMicrotask(() => (m.get("message") ?? []).forEach((l) => l({ data: cloned })));
  };
  const worker = {
    addEventListener: on(workerListeners),
    postMessage: (data: unknown) => deliver(portListeners, data),
    terminate: () => undefined,
  } as unknown as Worker;
  const port = { addEventListener: on(portListeners), postMessage: (data: unknown) => deliver(workerListeners, data) };
  return { worker, port };
}

describe("worker RPC errors", () => {
  it("carry code, errors and details to the caller", async () => {
    const { worker, port } = pair();
    const g = globalThis as { self?: unknown };
    const saved = g.self;
    g.self = port;
    try {
      serveRpc<{ type: "x"; ok: boolean }>((req) => {
        if (req.ok) return Promise.resolve({ result: 42 });
        return Promise.reject(
          new CommandEngineError("COMMAND_REF_FAILED", "reference fails", [], { code: "REF_AMBIGUOUS", unresolved: [{ key: "", candidates: [] }] }),
        );
      });
    } finally {
      g.self = saved;
    }
    const rpc = new WorkerRpc<{ type: "x"; ok: boolean }>(worker);
    await expect(rpc.call({ type: "x", ok: true })).resolves.toBe(42);
    const e = (await rpc.call({ type: "x", ok: false }).catch((x: unknown) => x)) as RpcError;
    expect(e.message).toBe("reference fails");
    expect(e.code).toBe("COMMAND_REF_FAILED");
    expect(e.details).toEqual({ code: "REF_AMBIGUOUS", unresolved: [{ key: "", candidates: [] }] });
    const c = toCommandEngineError(e);
    expect(c).toBeInstanceOf(CommandEngineError);
    expect(c.toJSON()).toEqual({
      code: "COMMAND_REF_FAILED",
      message: "reference fails",
      errors: [],
      details: { code: "REF_AMBIGUOUS", unresolved: [{ key: "", candidates: [] }] },
    });
  });

  it("plain errors keep only their message (and become ENGINE_FAILED)", async () => {
    const { worker, port } = pair();
    const g = globalThis as { self?: unknown };
    const saved = g.self;
    g.self = port;
    try {
      serveRpc<{ type: "x" }>(() => Promise.reject(new Error("boom")));
    } finally {
      g.self = saved;
    }
    const rpc = new WorkerRpc<{ type: "x" }>(worker);
    const e = (await rpc.call({ type: "x" }).catch((x: unknown) => x)) as RpcError;
    expect(e.message).toBe("boom");
    expect(e.code).toBeUndefined();
    expect(toCommandEngineError(e).code).toBe("ENGINE_FAILED");
  });

  /** Serve `handler` on a fresh in-memory worker and return its client. */
  function serve<Req extends { type: string }>(handler: (req: Req) => Promise<{ result: unknown }>): WorkerRpc<Req> {
    const { worker, port } = pair();
    const g = globalThis as { self?: unknown };
    const saved = g.self;
    g.self = port;
    try {
      serveRpc<Req>(handler);
    } finally {
      g.self = saved;
    }
    return new WorkerRpc<Req>(worker);
  }

  it("still reply, with the message and code, when details do not serialise (a BigInt, a cycle)", async () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    const rpc = serve<{ type: "x"; which: number }>((req) =>
      Promise.reject(
        req.which === 0
          ? new CommandEngineError("COMMAND_NOT_EXACT", "big", [], { n: 10n as unknown as number })
          : new CommandEngineError("COMMAND_NOT_EXACT", "cycle", [], cyclic),
      ),
    );
    for (const [which, message] of [
      [0, "big"],
      [1, "cycle"],
    ] as const) {
      const e = (await rpc.call({ type: "x", which }).catch((x: unknown) => x)) as RpcError;
      expect(e.message).toBe(message);
      expect(e.code).toBe("COMMAND_NOT_EXACT");
      expect(e.details).toBeUndefined();
    }
  });

  it("answer a result that does not clone with an error reply, not a hung call", async () => {
    const rpc = serve<{ type: "x" }>(() => Promise.resolve({ result: { f: () => 1 } }));
    const e = (await rpc.call({ type: "x" }).catch((x: unknown) => x)) as RpcError;
    expect(e).toBeInstanceOf(Error);
    expect(e.message.length).toBeGreaterThan(0);
  });

  it("answer an error whose message getter throws", async () => {
    const weird = new Error("hidden");
    Object.defineProperty(weird, "message", {
      get() {
        throw new Error("no message");
      },
    });
    const rpc = serve<{ type: "x" }>(() => Promise.reject(weird));
    const e = (await rpc.call({ type: "x" }).catch((x: unknown) => x)) as RpcError;
    expect(e.message).toBe("the worker failed with an error that cannot be described");
  });
});

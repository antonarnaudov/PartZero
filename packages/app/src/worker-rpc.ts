/**
 * A tiny request/response RPC over `postMessage`, used by the CadScript and forge-web workers.
 * Requests carry an `id`; each response resolves (or rejects) the matching promise.
 */

export type RpcRequest = { type: string };

interface Envelope<Req> {
  id: number;
  req: Req;
}

/**
 * A failed reply carries the error's message and, when the error has them, its machine-readable
 * `code` and `data` (`{ errors, details }`, e.g. a forge-web command refusal), which the caller's
 * rejection keeps as properties.
 */
type Reply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: string; data?: { errors?: unknown; details?: unknown } };

/** An RPC failure with the worker-side error's `code`, `errors` and `details` (when it had them). */
export interface RpcError extends Error {
  code?: string;
  errors?: unknown;
  details?: unknown;
}

function replyError(reply: { error: string; code?: string; data?: { errors?: unknown; details?: unknown } }): RpcError {
  const e = new Error(reply.error) as RpcError;
  if (reply.code !== undefined) e.code = reply.code;
  if (reply.data?.errors !== undefined) e.errors = reply.data.errors;
  if (reply.data?.details !== undefined) e.details = reply.data.details;
  return e;
}

/**
 * The error reply for `err`: its message, `code`, and `errors`/`details` as plain JSON. Never
 * throws — a reply that cannot be built (a message getter or `code` that throws, `details` with a
 * BigInt or a cycle) degrades to what can be, so the caller's promise always settles.
 */
function errorReply(id: number, err: unknown): Reply {
  let message: string;
  try {
    message = err instanceof Error ? err.message : String(err);
  } catch {
    message = "the worker failed with an error that cannot be described";
  }
  const reply: Reply = { id, ok: false, error: message };
  try {
    const o = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
    if (typeof o["code"] === "string") reply.code = o["code"];
    if (o["errors"] !== undefined || o["details"] !== undefined) {
      // Plain JSON only: structured clone would reject functions or class instances.
      reply.data = JSON.parse(JSON.stringify({ errors: o["errors"], details: o["details"] })) as { errors?: unknown; details?: unknown };
    }
  } catch {
    // `errors`/`details` that do not serialise (a BigInt, a cycle): the message and code stay.
    delete reply.data;
  }
  return reply;
}

/** Post `reply`; when it cannot be posted (a result that does not clone), post an error reply instead, and never throw. */
function postReply(port: PortLike, reply: Reply, transfer: Transferable[] = []): void {
  try {
    port.postMessage(reply, transfer);
  } catch (e) {
    try {
      port.postMessage(errorReply(reply.id, e));
    } catch {
      port.postMessage({ id: reply.id, ok: false, error: "the worker's reply could not be posted" } satisfies Reply);
    }
  }
}

interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (e: Event) => void): void;
}

export class WorkerRpc<Req extends RpcRequest> {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private dead: Error | null = null;
  private readonly worker: Worker;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.addEventListener("message", (e: MessageEvent<Reply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(replyError(e.data));
    });
    worker.addEventListener("error", (e: ErrorEvent) => {
      this.fail(new Error(`worker error: ${e.message || "failed to load"}`));
    });
    worker.addEventListener("messageerror", () => this.fail(new Error("worker message could not be deserialized")));
  }

  call<R>(req: Req, transfer: Transferable[] = []): Promise<R> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const envelope: Envelope<Req> = { id, req };
      this.worker.postMessage(envelope, transfer);
    });
  }

  terminate(): void {
    this.fail(new Error("worker terminated"));
    this.worker.terminate();
  }

  private fail(err: Error): void {
    this.dead ??= err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

/** Worker side: answer every request with `handler`. */
export function serveRpc<Req extends RpcRequest>(
  handler: (req: Req) => Promise<{ result: unknown; transfer?: Transferable[] }>,
): void {
  const port = self as unknown as PortLike;
  port.addEventListener("message", (e: MessageEvent<Envelope<Req>>) => {
    const { id, req } = e.data;
    // Run inside a promise so synchronous throws become error replies, not hung calls.
    Promise.resolve(req).then(handler).then(
      ({ result, transfer }) => postReply(port, { id, ok: true, result } satisfies Reply, transfer ?? []),
      (err: unknown) => postReply(port, errorReply(id, err)),
    );
  });
}

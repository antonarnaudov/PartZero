/**
 * A tiny request/response RPC over `postMessage`, used by the CadScript and forge-web workers.
 * Requests carry an `id`; each response resolves (or rejects) the matching promise.
 */

export type RpcRequest = { type: string };

interface Envelope<Req> {
  id: number;
  req: Req;
}

type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

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
      else p.reject(new Error(e.data.error));
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
      ({ result, transfer }) => port.postMessage({ id, ok: true, result } satisfies Reply, transfer ?? []),
      (err: unknown) => port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Reply),
    );
  });
}

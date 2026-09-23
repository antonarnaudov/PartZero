/**
 * Web Worker entry: runs `evaluate` off the main thread (see `createEvaluator`).
 *
 * Messages in:  `{ id, ir, options?, wasm? }` — `wasm` (first message only) is a compiled
 *               `WebAssembly.Module` (or URL/bytes) so the worker skips fetching/compiling.
 * Messages out: `{ id, ok: true, result }` (typed arrays transferred, not copied) or
 *               `{ id, ok: false, error: { code, message } }`.
 */
import { evaluate, init, transferables } from "./engine.js";
import type { EvaluateOptions, InitInput, IrInput } from "./types.js";

interface Request {
  id: number;
  ir: IrInput;
  options?: EvaluateOptions;
  wasm?: InitInput;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (e: MessageEvent<Request>) => {
  const { id, ir, options, wasm } = e.data;
  void (async () => {
    try {
      await init(wasm);
      const t0 = performance.now();
      const result = evaluate(ir, options);
      result.timings.totalMs = performance.now() - t0;
      scope.postMessage({ id, ok: true, result }, transferables(result));
    } catch (err) {
      const x = err as { code?: string; message?: string };
      scope.postMessage({ id, ok: false, error: { code: x.code ?? "FORGE_WORKER", message: x.message ?? String(err) } });
    }
  })();
};

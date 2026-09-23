/**
 * Off-main-thread evaluation: a Web Worker running `evaluate`, with results transferred
 * (not copied) back. Rendering stays on the main thread; feed `result.bodies` to
 * `Viewport.setBodies`.
 */
import { forgeError, init, wasmModule } from "./engine.js";
import type { EvaluateOptions, EvaluateResult, InitInput, IrInput } from "./types.js";

export interface Evaluator {
  /** Evaluate in the worker. Requests are answered in order. */
  evaluate(ir: IrInput, options?: EvaluateOptions): Promise<EvaluateResult>;
  /** Stop the worker; pending requests reject with `FORGE_WORKER_TERMINATED`. */
  terminate(): void;
}

export interface EvaluatorOptions {
  /** Use this worker (must run `@aicad/forge-web/worker`) instead of spawning one. */
  worker?: Worker;
  /** WASM for the worker; default: the module this thread compiled (after `init()`), else the default URL. */
  wasm?: InitInput;
}

type Pending = { resolve: (r: EvaluateResult) => void; reject: (e: Error) => void };
type Reply =
  | { id: number; ok: true; result: EvaluateResult }
  | { id: number; ok: false; error: { code: string; message: string } };

/** Spawn an evaluation worker. Call `await init()` first to share the compiled module with it. */
export function createEvaluator(options: EvaluatorOptions = {}): Evaluator {
  const worker = options.worker ?? new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const pending = new Map<number, Pending>();
  let next = 1;
  let wasmSent = false;
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const r = e.data;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.result);
    else p.reject(forgeError(r.error.code, r.error.message));
  };
  worker.onerror = (e: ErrorEvent) => {
    const err = forgeError("FORGE_WORKER", e.message || "the evaluation worker failed");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return {
    evaluate(ir, opts) {
      const id = next++;
      return new Promise<EvaluateResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const msg: { id: number; ir: IrInput; options?: EvaluateOptions; wasm?: InitInput } = { id, ir };
        if (opts) msg.options = opts;
        if (!wasmSent) {
          const wasm = options.wasm ?? wasmModule();
          if (wasm) msg.wasm = wasm;
          wasmSent = true;
        }
        worker.postMessage(msg);
      });
    },
    terminate() {
      worker.terminate();
      const err = forgeError("FORGE_WORKER_TERMINATED", "the evaluation worker was terminated");
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    },
  };
}

/** `init()` then `createEvaluator()`, so the worker reuses this thread's compiled module. */
export async function createSharedEvaluator(options: EvaluatorOptions = {}): Promise<Evaluator> {
  if (!options.wasm) await init();
  return createEvaluator(options);
}

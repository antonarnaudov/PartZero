/**
 * @aicad/forge-web — Forge (evaluation + tessellation) and forge-render (the CAD
 * viewport) for the web, compiled from Rust to WebAssembly.
 *
 * ```ts
 * import { init, evaluate, Viewport } from "@aicad/forge-web";
 * await init();
 * const result = evaluate(irJson);              // or createEvaluator() for a worker
 * const viewport = await Viewport.create(canvas);
 * viewport.attachControls();
 * viewport.setBodies(result.bodies);
 * const hit = await viewport.pick(x, y);        // { kind, body, face, edge, point, … }
 * ```
 *
 * See README.md for the full contract.
 */
export { engineVersion, evaluate, exportMesh, init, transferables, wasmModule } from "./engine.js";
export { createEvaluator, createSharedEvaluator, type Evaluator, type EvaluatorOptions } from "./evaluator.js";
export { Viewport } from "./viewport.js";
export type * from "./types.js";

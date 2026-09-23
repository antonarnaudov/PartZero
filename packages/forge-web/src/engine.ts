/**
 * Loading the Forge WASM module, and the stateless engine functions.
 */
import initWasm, * as raw from "../pkg/forge_wasm.js";
import type {
  EvaluateOptions,
  EvaluateResult,
  ExportOptions,
  ForgeError,
  InitInput,
  IrInput,
  MeshFormat,
  MigrateResult,
  ParamReport,
  WriteBackOptions,
  WriteBackResult,
} from "./types.js";

let ready: Promise<WebAssembly.Module> | null = null;
let compiled: WebAssembly.Module | null = null;

async function compile(input: InitInput | undefined): Promise<WebAssembly.Module> {
  if (input instanceof WebAssembly.Module) return input;
  let source: InitInput = input ?? new URL("../pkg/forge_wasm_bg.wasm", import.meta.url);
  if (typeof source === "string" || source instanceof URL) {
    source = await fetch(source);
  } else if (typeof Request !== "undefined" && source instanceof Request) {
    source = await fetch(source);
  }
  if (typeof Response !== "undefined" && source instanceof Response) {
    if (!source.ok) {
      throw forgeError("FORGE_WASM_FETCH", `cannot fetch the Forge wasm: ${source.status} ${source.statusText} (${source.url})`);
    }
    const type = source.headers.get("Content-Type") ?? "";
    if (typeof WebAssembly.compileStreaming === "function" && type.startsWith("application/wasm")) {
      return WebAssembly.compileStreaming(source);
    }
    return WebAssembly.compile(await source.arrayBuffer());
  }
  return WebAssembly.compile(source as BufferSource);
}

/**
 * Load and instantiate the Forge WASM module (idempotent; later calls return the same
 * promise). By default the `.wasm` next to the JS glue is fetched; pass a URL, bytes or a
 * compiled `WebAssembly.Module` to override (e.g. in Node, or to share one compilation
 * with a worker — see {@link wasmModule}).
 */
export function init(input?: InitInput): Promise<void> {
  ready ??= (async () => {
    const module = await compile(input);
    await initWasm({ module_or_path: module });
    compiled = module;
    return module;
  })();
  return ready.then(() => undefined);
}

/** The compiled module once {@link init} resolved (post it to workers to skip recompiling). */
export function wasmModule(): WebAssembly.Module | null {
  return compiled;
}

function assertReady(): void {
  if (!compiled) throw forgeError("FORGE_NOT_INITIALIZED", "call `await init()` before using @aicad/forge-web");
}

export function forgeError(code: string, message: string): ForgeError {
  const e = new Error(message) as ForgeError;
  e.code = code;
  return e;
}

export function irText(ir: IrInput): string {
  return typeof ir === "string" ? ir : JSON.stringify(ir);
}

/**
 * Evaluate an IR document (forge-regen) and tessellate every body for rendering
 * (`forge_mesh::tessellate_render`: per-face vertices, exact normals, face ranges and edge
 * polylines named by provenance). Synchronous; use {@link createEvaluator} to run it in a
 * worker. Throws a {@link ForgeError} only for invalid options (`MESH_INVALID_PARAMS`,
 * `REPORT_VERSION`). `reportVersion: "v1"` gives a v0 document the `aicad.metrics/1` report.
 */
export function evaluate(ir: IrInput, options: EvaluateOptions = {}): EvaluateResult {
  assertReady();
  return raw.evaluate(
    irText(ir),
    options.chordalDeflection,
    options.angularDeflection,
    options.reportVersion,
  ) as EvaluateResult;
}

/**
 * `migrate_v0_to_v1` (SPEC-v1 §9.1): the canonical `aicad.ir/1` text of a v0 document and the
 * ids it rewrote; a v1 document is returned unchanged, in canonical form. Throws a
 * {@link ForgeError} with `errors` for a rejected document (v0 documents keep their v0 codes).
 */
export function migrate(ir: IrInput): MigrateResult {
  assertReady();
  return raw.migrate(irText(ir)) as MigrateResult;
}

/**
 * The `params` block of the document's `aicad.metrics/1` report — every parameter's value or
 * failure — without evaluating any feature (cheap enough for parameter chips on every edit).
 * Throws a {@link ForgeError} with `errors` for a rejected document.
 */
export function params(ir: IrInput): ParamReport[] {
  assertReady();
  return raw.params(irText(ir)) as ParamReport[];
}

/**
 * `writeBackSolution` (SPEC-v1 §0.6): the document with the solved geometry of each
 * constrained sketch (or of `options.sketches`) stored, as canonical `aicad.ir/1` text. The
 * command layer applies it as an ordinary undoable edit; it is idempotent. Throws a
 * {@link ForgeError} for a rejected document or an unknown sketch id
 * (`WRITE_BACK_UNKNOWN_SKETCH`).
 */
export function writeBack(ir: IrInput, options: WriteBackOptions = {}): WriteBackResult {
  assertReady();
  return raw.writeBack(irText(ir), options.sketches) as WriteBackResult;
}

/**
 * Evaluate, tessellate (watertight) and encode all bodies as 3MF, binary STL or OBJ
 * (forge-io), like `aicad export`. Throws a {@link ForgeError} (e.g. a feature error unless
 * `allowPartial`, `EXPORT_NO_BODIES`, `EXPORT_FORMAT`).
 */
export function exportMesh(ir: IrInput, format: MeshFormat, options: ExportOptions = {}): Uint8Array {
  assertReady();
  return raw.exportMesh(
    irText(ir),
    format,
    options.chordalDeflection,
    options.angularDeflection,
    options.allowPartial ?? false,
  );
}

/** The engine identifier (`forge <version>`), as written into reports. */
export function engineVersion(): string {
  assertReady();
  return raw.engineVersion();
}

/** Typed arrays of a result, for zero-copy `postMessage` transfer. */
export function transferables(result: EvaluateResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const b of result.bodies) {
    out.push(b.positions.buffer as ArrayBuffer, b.normals.buffer as ArrayBuffer, b.indices.buffer as ArrayBuffer);
    for (const e of b.edges) out.push(e.points.buffer as ArrayBuffer);
  }
  return out;
}

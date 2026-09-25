/**
 * `@aicad/forge-web/sketch`: the interactive sketch session (plan contract C5) over the
 * `forge-sketch-wasm` module. It runs on the UI thread — solves are ~ms — so a drag never
 * waits behind a regeneration in the engine worker.
 *
 * ```ts
 * import { initSketch, SketchSession } from "@aicad/forge-web/sketch";
 * await initSketch();
 * const s = SketchSession.create({ id: "sketch1", name: "sketch1", plane: "XY" });
 * s.apply([{ op: "addCurve", curve: { kind: "line", id: "l1", start: [0, 0], end: [10, 0] } }]);
 * const { feature } = s.finish(); // an IR v1 sketch feature for the command layer
 * ```
 *
 * The session never throws for sketch problems: results are `{ ok: false, error }` with a
 * stable code (`SKETCH_CONSTRAINT_CONFLICT`, `DEGENERATE_CURVE`, `SESSION_REDUNDANT`, …).
 */
import initSketchWasm, { RawSketchSession, initSync, sketchEngineVersion } from "../pkg-sketch/forge_sketch_wasm.js";
import type { v1 } from "@aicad/ir-types";
import type {
  ApplyOptions,
  ApplyResult,
  DragResult,
  DragSpec,
  FinishResult,
  SessionError,
  SketchEdit,
  SketchLoadRequest,
  SketchSnapshot,
  ValueResult,
} from "./types/sketch.js";

export type * from "./types/sketch.js";

/** What {@link initSketch} accepts: a URL, the bytes, or a compiled module. */
export type SketchInitInput = string | URL | Request | Response | BufferSource | WebAssembly.Module;

let ready: Promise<void> | null = null;
let initialized = false;

/**
 * Load the sketch WASM module (idempotent). By default the `.wasm` next to the JS glue is
 * fetched; pass bytes in Node.
 */
export function initSketch(input?: SketchInitInput): Promise<void> {
  ready ??= (async () => {
    const source = input ?? new URL("../pkg-sketch/forge_sketch_wasm_bg.wasm", import.meta.url);
    await initSketchWasm({ module_or_path: source });
    initialized = true;
  })();
  return ready;
}

/** Synchronous init from bytes or a compiled module (tests, workers). */
export function initSketchSync(bytes: BufferSource | WebAssembly.Module): void {
  if (initialized) return;
  initSync({ module: bytes });
  initialized = true;
  ready = Promise.resolve();
}

/** The module is loaded. */
export function sketchReady(): boolean {
  return initialized;
}

/** The sketch engine's crate version. */
export function sketchVersion(): string {
  assertReady();
  return sketchEngineVersion();
}

/** A load failure (`SESSION_*` codes), thrown by {@link SketchSession.load}. */
export class SketchSessionError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly path: string | undefined;

  constructor(e: SessionError) {
    super(e.message);
    this.name = "SketchSessionError";
    this.code = e.code;
    this.details = e.details ?? {};
    this.path = e.path;
  }
}

function assertReady(): void {
  if (!initialized) throw new SketchSessionError({ code: "FORGE_NOT_INITIALIZED", message: "call `await initSketch()` before using @aicad/forge-web/sketch" });
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** One sketch being edited (see `forge_sketch::session`). Call {@link dispose} when done. */
export class SketchSession {
  #raw: RawSketchSession | null;

  private constructor(raw: RawSketchSession) {
    this.#raw = raw;
  }

  /** Load an existing sketch (literal geometry) with the document its expressions use. */
  static load(request: SketchLoadRequest): SketchSession {
    assertReady();
    try {
      return new SketchSession(new RawSketchSession(JSON.stringify(request)));
    } catch (e) {
      if (typeof e === "string") throw new SketchSessionError(parse<SessionError>(e));
      throw e;
    }
  }

  /** A new, empty sketch on `plane`. */
  static create(options: { id: string; name: string; plane: v1.PlaneRef; document?: v1.IrDocument; part?: string }): SketchSession {
    const request: SketchLoadRequest = {
      sketch: { type: "sketch", id: options.id, name: options.name, plane: options.plane, curves: [] },
      ...(options.document ? { document: options.document } : {}),
      ...(options.part ? { part: options.part } : {}),
    };
    return SketchSession.load(request);
  }

  get #s(): RawSketchSession {
    if (!this.#raw) throw new SketchSessionError({ code: "SESSION_DISPOSED", message: "the sketch session was disposed" });
    return this.#raw;
  }

  snapshot(): SketchSnapshot {
    return parse(this.#s.snapshot());
  }

  /** Apply an edit batch atomically (rejected whole on error; see the module docs). */
  apply(edits: readonly SketchEdit[], options: ApplyOptions = {}): ApplyResult {
    return parse(this.#s.apply(JSON.stringify(edits), JSON.stringify(options)));
  }

  /** Solve an edit batch without committing it. */
  preview(edits: readonly SketchEdit[], options: ApplyOptions = {}): ApplyResult {
    return parse(this.#s.preview(JSON.stringify(edits), JSON.stringify(options)));
  }

  undo(): SketchSnapshot {
    return parse(this.#s.undo());
  }

  redo(): SketchSnapshot {
    return parse(this.#s.redo());
  }

  dragBegin(spec: DragSpec): { ok: true } | { ok: false; error: SessionError } {
    return parse(this.#s.dragBegin(JSON.stringify(spec)));
  }

  dragTo(u: number, v: number): DragResult {
    return parse(this.#s.dragTo(u, v));
  }

  dragEnd(): ApplyResult {
    return parse(this.#s.dragEnd());
  }

  dragCancel(): void {
    this.#s.dragCancel();
  }

  /** Evaluate an expression typed into a dimension (mm for `length`, degrees for `angle`). */
  evalExpression(expr: string, field: "length" | "angle" | "count" | "ratio" = "length"): ValueResult {
    return parse(this.#s.evalExpression(expr, field));
  }

  /** Define a document parameter (`width = 40`); returned by {@link finish} for `addParam`. */
  defineParam(name: string, unit: "mm" | "deg" | "ratio" | "count", value: string): ValueResult {
    return parse(this.#s.defineParam(name, unit, value));
  }

  /** The finished IR v1 feature, evaluated and validated. */
  finish(): FinishResult {
    return parse(this.#s.finish());
  }

  /** Every committed edit since load. */
  edits(): SketchEdit[] {
    return parse(this.#s.edits());
  }

  /** The current sketch feature (as committed). */
  feature(): v1.SketchFeature {
    return parse(this.#s.feature());
  }

  dispose(): void {
    this.#raw?.free();
    this.#raw = null;
  }
}

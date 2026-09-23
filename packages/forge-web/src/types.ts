/**
 * Public types of `@aicad/forge-web` — the contract between the Forge engine (Rust → WASM)
 * and the app shell. Hand-written; the raw wasm-bindgen types in `pkg/` are internal.
 *
 * Units: millimetres for geometry, CSS pixels for everything on screen (the viewport
 * applies the device-pixel ratio itself).
 */
import type { EvalReport, IrDocument } from "@aicad/ir-types";

export type { EvalReport, IrDocument };

/** An IR document as JSON text or as an already-parsed object. */
export type IrInput = string | IrDocument | Record<string, unknown>;

/** Tessellation tolerances. Defaults: 0.05 mm chordal, 0.35 rad (≈ 20°) angular. */
export interface TessellationOptions {
  /** Maximum distance between the mesh and the exact surface, mm (≥ 1e-5). */
  chordalDeflection?: number;
  /** Maximum normal deviation along a mesh edge, radians, in (0, π]. */
  angularDeflection?: number;
}

/** The triangles of one B-rep face: `indices[3*start .. 3*(start+count))`. */
export interface FaceRange {
  /** The face's provenance name, e.g. `plate/cap:end`. */
  face: string;
  /** First triangle (a triangle index, not an index-buffer offset). */
  start: number;
  /** Number of triangles. */
  count: number;
}

/** One B-rep edge as the exact polyline its adjacent faces share. */
export interface EdgePolyline {
  /** The edge's provenance name, e.g. `plate/edge:{plate/cap:end|plate/side:bottom}`. */
  edge: string;
  /** xyz triples (mm); a closed (ring) edge repeats its first point at the end. */
  points: Float32Array;
}

/** A tessellated body, ready for {@link Viewport.setBodies}. */
export interface RenderBody {
  /** `part/feature`, or `part/feature#i` when a feature produced several bodies. */
  name: string;
  /** xyz triples (mm). Vertices are split per face (creases stay sharp). */
  positions: Float32Array;
  /** Unit outward normals from the exact surfaces, one per position. */
  normals: Float32Array;
  /** Triangles (3 indices each), counter-clockwise seen from outside. */
  indices: Uint32Array;
  /** Per-face triangle ranges, in face order. */
  faceRanges: FaceRange[];
  /** Per-edge polylines, in edge order. */
  edges: EdgePolyline[];
  /** Optional display colour (sRGB, 0..1). Not produced by `evaluate`. */
  color?: [number, number, number];
}

/** A body that evaluated but could not be tessellated. */
export interface MeshError {
  body: string;
  /** `MESH_*` code. */
  code: string;
  message: string;
}

/** Milliseconds per phase, measured inside the engine. */
export interface EvaluateTimings {
  /** JSON parse + structural validation. */
  parseMs: number;
  /** Feature evaluation + metrics report. */
  evaluateMs: number;
  /** Tessellation of all bodies. */
  tessellateMs: number;
  /** Building the JS result objects (typed-array copies out of WASM memory). */
  packMs?: number;
  /** Upload to the GPU (only {@link Viewport.loadIr}). */
  uploadMs?: number;
  /** Everything above. */
  totalMs: number;
}

/** Result of {@link evaluate}. */
export interface EvaluateResult {
  /**
   * The `aicad.metrics/0` report. A document that fails to parse or validate is not an
   * exception: the report has `status: "error"` and a document-level `error`, and
   * `bodies` is empty.
   */
  report: EvalReport;
  /** Bodies of every successful body feature, in timeline order. */
  bodies: RenderBody[];
  /** Bodies that failed to tessellate (rare; reported, never silently dropped). */
  meshErrors: MeshError[];
  timings: EvaluateTimings;
}

/** Mesh export formats of {@link exportMesh}. `stl` is binary STL. */
export type MeshFormat = "3mf" | "stl" | "obj";

export interface ExportOptions extends TessellationOptions {
  /** Export the bodies that did evaluate even if some features failed (default false). */
  allowPartial?: boolean;
}

/** Errors thrown by the engine carry a stable machine-readable `code`. */
export interface ForgeError extends Error {
  code: string;
}

/** Graphics backend in use. */
export type Backend = "webgpu" | "webgl2";

/** Standard views (Z up). */
export type StandardView = "iso" | "top" | "front" | "right" | "bottom" | "back" | "left";

export type Projection = "perspective" | "orthographic";

export interface ViewportOptions {
  /** `"auto"` (default): WebGPU when available, else WebGL2. */
  backend?: "auto" | Backend;
  /** CSS size; defaults to the canvas's client size (or its pixel size / dpr). */
  width?: number;
  height?: number;
  /** Device-pixel ratio; defaults to `globalThis.devicePixelRatio ?? 1`. */
  devicePixelRatio?: number;
  /**
   * Render on demand with `requestAnimationFrame` whenever something changes
   * (default true). With `false`, call {@link Viewport.render} yourself.
   */
  autoRender?: boolean;
  /** Keep the canvas size in sync with its CSS box via ResizeObserver (default true; HTMLCanvasElement only). */
  autoResize?: boolean;
  /** Custom wasm location or module for {@link init} (default: next to the JS glue). */
  wasm?: InitInput;
  /** Initial display options. */
  display?: DisplayOptions;
}

/** Display options; any subset may be passed to {@link Viewport.setDisplayOptions}. */
export interface DisplayOptions {
  /** B-rep edge width, CSS px (default 1.25). */
  edgeWidth?: number;
  /** Silhouette width, CSS px (default 1.25). */
  silhouetteWidth?: number;
  /** Width multiplier of hovered/selected edges (default 2.2). */
  highlightWidthScale?: number;
  /** Depth bias of lines towards the viewer, px of depth (default 1.5). */
  lineDepthBias?: number;
  /** Edge-snapping radius of {@link Viewport.pick}, CSS px (default 4; 0 = pixel-exact). */
  pickRadius?: number;
  grid?: boolean;
  axes?: boolean;
  edges?: boolean;
  silhouettes?: boolean;
}

/** What {@link Viewport.pick} found under the cursor. */
export interface PickResult {
  /** `section` = the cap of a body cut by the section plane. */
  kind: "face" | "edge" | "section";
  /** Body name (as in {@link RenderBody.name}). */
  body: string;
  /** Index into the bodies passed to {@link Viewport.setBodies}. */
  bodyIndex: number;
  /** Face provenance name (face hits; for a section cap, the face behind the cut). */
  face: string | null;
  faceIndex: number | null;
  /** Edge provenance name (edge hits). */
  edge: string | null;
  edgeIndex: number | null;
  /** World point under the picked pixel (mm), or null. */
  point: [number, number, number] | null;
  /** The picked pixel in CSS px (for edge snaps, the snapped edge pixel). */
  pixel: [number, number];
}

/**
 * A face or edge to highlight: a {@link PickResult}, or names only. Names are provenance,
 * so a selection kept by name survives re-evaluation (a dimension edit) as long as the
 * entity still exists.
 */
export type EntityRef =
  | PickResult
  | { body: string; face: string; edge?: null }
  | { body: string; edge: string; face?: null };

/** A section plane: the half-space the normal points into is cut away. */
export interface SectionPlane {
  origin: [number, number, number];
  normal: [number, number, number];
}

/** Camera state, for persistence and view sync. */
export interface CameraState {
  target: [number, number, number];
  distance: number;
  yaw: number;
  pitch: number;
  fovY: number;
  projection: Projection;
}

/** Scene counters and frame timing. */
export interface ViewportStats {
  backend: Backend;
  adapter: string;
  bodies: number;
  faces: number;
  edges: number;
  triangles: number;
  vertices: number;
  edgeSegments: number;
  silhouetteCandidates: number;
  drawCalls: number;
  sampleCount: number;
  /** Target size in physical pixels. */
  width: number;
  height: number;
  frames: number;
  /** CPU time of the last `render()` (encode + submit), ms. */
  lastFrameMs: number;
  /** Exponential moving average of the CPU frame time, ms. */
  avgFrameMs: number;
  /** Average interval between the last rendered frames, ms (0 when idle). */
  frameIntervalMs: number;
}

/** Result of {@link Viewport.loadIr}: like {@link EvaluateResult} without the meshes. */
export interface LoadResult {
  report: EvalReport;
  meshErrors: MeshError[];
  timings: EvaluateTimings;
}

/** Mouse mapping of {@link Viewport.attachControls}. */
export interface ControlsOptions {
  /** Highlight what is under the pointer (default true). */
  hover?: boolean;
  /** Click selects (shift/ctrl/meta toggles) (default true). */
  select?: boolean;
  /** Left-drag action (default "orbit"); middle drags pan, right drags orbit, shift+left pans. */
  leftDrag?: "orbit" | "pan";
}

export type ViewportEvent =
  | { type: "hover"; pick: PickResult | null }
  | { type: "select"; selection: PickResult[]; pick: PickResult | null }
  | { type: "frame"; stats: ViewportStats };

/** Input accepted by {@link init}: a URL of the `.wasm`, its bytes, or a compiled module. */
export type InitInput = string | URL | Request | Response | BufferSource | WebAssembly.Module;

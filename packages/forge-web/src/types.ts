/**
 * Public types of `@aicad/forge-web` — the contract between the Forge engine (Rust → WASM)
 * and the app shell. Hand-written; the raw wasm-bindgen types in `pkg/` are internal.
 *
 * Units: millimetres for geometry, CSS pixels for everything on screen (the viewport
 * applies the device-pixel ratio itself).
 */
import type { EvalReport, IrDocument, metricsV1, v1 } from "@aicad/ir-types";

export type { EvalReport, IrDocument };

/** An `aicad.ir/1` document (SPEC-v1). */
export type IrDocumentV1 = v1.IrDocument;
/** The `aicad.metrics/1` report of an `aicad.ir/1` document (SPEC-v1 §7). */
export type EvalReportV1 = metricsV1.EvalReport;
/**
 * The report `evaluate` returns: `aicad.metrics/0` for an `aicad.ir/0` document,
 * `aicad.metrics/1` for everything else (narrow on `schema`): an `aicad.ir/1` document, and the
 * rejection of any other or missing `schema` (`UNSUPPORTED_SCHEMA`) or of text that is not
 * JSON (`IR_PARSE_ERROR`), SPEC-v1 §0.5 rule 4.
 */
export type AnyEvalReport = EvalReport | EvalReportV1;

/** An IR document (either version) as JSON text or as an already-parsed object. */
export type IrInput = string | IrDocument | IrDocumentV1 | Record<string, unknown>;

/** Tessellation tolerances. Defaults: 0.05 mm chordal, 0.35 rad (≈ 20°) angular. */
export interface TessellationOptions {
  /** Maximum distance between the mesh and the exact surface, mm (≥ 1e-5). */
  chordalDeflection?: number;
  /** Maximum normal deviation along a mesh edge, radians, in (0, π]. */
  angularDeflection?: number;
}

/**
 * Which report an `aicad.ir/0` document gets: `"auto"` (default) keeps its `aicad.metrics/0`
 * report; `"v1"` migrates it (SPEC-v1 §9.1) and returns the `aicad.metrics/1` report of SPEC-v1
 * §0.2 rule 4 (with `migration` when ids were rewritten). An `aicad.ir/1` document always gets
 * the v1 report. Same values as `aicad eval --report-version`.
 */
export type ReportVersion = "auto" | "v1";

/** Options of {@link evaluate}, the evaluator and {@link Viewport.loadIr}. */
export interface EvaluateOptions extends TessellationOptions {
  /** Default `"auto"`. Any other value throws `REPORT_VERSION`. */
  reportVersion?: ReportVersion;
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
   * The metrics report: `aicad.metrics/0` for an `aicad.ir/0` document (unless
   * `reportVersion: "v1"`), `aicad.metrics/1` for anything else (narrow on `report.schema`).
   * A document that fails to parse or validate is not an exception: the report has
   * `status: "error"` and a document-level `error`, and `bodies` is empty. An unknown or
   * missing `schema` is `UNSUPPORTED_SCHEMA`; a document using the optional `draft`, which
   * Forge does not implement, is `UNSUPPORTED_FEATURE` (SPEC-v1 §6.9), and one using `hole`,
   * `fillet`, `chamfer`, `shell` or `pattern`, which Forge does not implement yet, is
   * `UNSUPPORTED_FEATURE_VERSION` at the feature's `/v` (SPEC-v1 §0.2 rule 3).
   */
  report: AnyEvalReport;
  /**
   * v0: the bodies of every successful body feature, in timeline order. v1: the final bodies
   * of every part (`report.parts[].bodies`), in canonical order.
   */
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

/** Options of {@link exportStep}. */
export interface StepExportOptions {
  /** STEP application protocol: `ap214` (default, the most widely read) or `ap242`. */
  schema?: "ap214" | "ap242";
  /** The STEP product name (default `part`). */
  productName?: string;
  /** Export the bodies that did evaluate even if some features failed (default false). */
  allowPartial?: boolean;
}

/** One problem of a rejected document (SPEC-v1 §0.5, §7.2 `error.details.errors`). */
export interface RejectionProblem {
  code: string;
  /** JSON pointer into the document. */
  path: string;
  message: string;
  details: Record<string, unknown>;
}

/** Errors thrown by the engine carry a stable machine-readable `code`. */
export interface ForgeError extends Error {
  code: string;
  /**
   * {@link migrate}, {@link params}, {@link writeBack} and the command-layer edits: every
   * problem of a rejected document (empty for a parse error or a usage error such as
   * `WRITE_BACK_UNKNOWN_SKETCH` or a `COMMAND_*` refusal).
   */
  errors?: RejectionProblem[];
  /** The command-layer edits: the structured context of a `COMMAND_*` refusal. */
  details?: Record<string, unknown>;
}

// ─── Command layer (SPEC-v1 §0.6, §5.9, §9.2; interface I7) ───────────────────────────────────

/**
 * The result of a command-layer edit: the edited document as canonical `aicad.ir/1` text
 * (verified by evaluation before it is returned), whether anything changed, and the op's
 * result (previous values for its inverse, the report data it used).
 */
export interface EditResult<R> {
  document: string;
  changed: boolean;
  result: R;
}

/** A value {@link setParam} stores: a literal, or an expression (canonicalised). */
export type ParamValueInput = number | boolean | string;

/** A reference's report entry (SPEC-v1 §5.8): members with probes, unresolved members with candidates. */
export type RefReport = metricsV1.RefReport;
/** A resolved member of a reference, with its probe (SPEC-v1 §7.6). */
export type RefMember = metricsV1.RefMember;
/** A repair candidate for an unresolved member (SPEC-v1 §5.8). */
export type RefCandidate = metricsV1.Candidate;
/** An unresolved member and its candidates. */
export type RefUnresolved = metricsV1.Unresolved;
/** A probe: a point on the entity (and the outward normal where defined), SPEC-v1 §7.6. */
export type Probe = metricsV1.Probe;
/** A Ref (SPEC-v1 §5.1): kind, query, cardinality and capture. */
export type IrRef = v1.Ref;
/** A reference's capture (SPEC-v1 §5.6). */
export type IrCapture = v1.Capture;

export interface SetParamResult {
  param: string;
  /** The stored value before (a literal or expression text). */
  previous: ParamValueInput;
  /** The stored value after: a JSON literal, or the canonical expression text (SPEC-v1 §2.4). */
  value: ParamValueInput;
  /** The edited document's `params` block (every value or failure). */
  params: ParamReport[];
}

export interface RenameFeatureResult {
  feature: string;
  previous: string;
  name: string;
}

export interface UpgradeFeatureResult {
  feature: string;
  type: string;
  from: number;
  to: number;
  /** Feature entries (by `feature_id`) and parts (by `part_id`) whose report changes. */
  diff: Array<{ feature_id?: string; part_id?: string; before: unknown; after: unknown }>;
}

export interface CaptureRefResult {
  feature: string;
  field: string;
  capture: IrCapture;
  /** The replaced capture, or `null`. */
  previous: IrCapture | null;
  /** The resolved members, with probes. */
  members: RefMember[];
}

/** One picked entity for `refFor`. */
export interface RefPick {
  kind: "face" | "edge" | "vertex" | "body";
  /** Its provenance name as the render mesh has it (`e1/edge:{e1/cap:end|e1/side:r.top}`, `#k` for split pieces). */
  name?: string;
  /** Its provenance key as the report's members have it. */
  key?: string;
  /** Where it was picked (mm): tells apart entities that share a name; locates a vertex. */
  point?: [number, number, number];
  /** Its body's origin (the report's `parts[].bodies[].origin`): required for a body pick. */
  body?: { feature: string; member: string; instance?: number[] };
}

/** What `refFor` builds a Ref for. */
export interface RefForRequest {
  /** The Ref's kind (`edge` from picked faces: their boundary edges; `body` from faces/edges: their owner). */
  kind: "face" | "edge" | "vertex" | "body";
  picks: RefPick[];
  /** Declared cardinality to write (default: the field's). */
  card?: "one" | "some" | "any" | number;
}

export interface RefForResult {
  /** The Ref: synthesized query and fresh capture. */
  ref: IrRef;
  /** What it resolves to, in canonical order. */
  members: Array<{ key: string; name: string; probe: RefMember["probe"] }>;
}

export interface AcceptRefResult {
  feature: string;
  field: string;
  /** The Ref written (query and fresh capture). */
  ref: IrRef;
  /** The Ref replaced. */
  previous: IrRef;
}

export interface AcceptRefProposalResult extends AcceptRefResult {
  /** The warning that carried the proposal: `REF_REPAIRED` or `REF_SET_CHANGED`. */
  code: string | null;
}

export interface AcceptRefCandidateResult extends AcceptRefResult {
  candidate: RefCandidate;
}

export interface RenameCurveResult {
  sketch: string;
  old: string;
  new: string;
  /** How many of each were rewritten: `curves`, `constraints`, `regions`, `points`, `queries`, `capture_keys`. */
  rewritten: Record<string, number>;
  /**
   * Rewritten captures the engine could not check against a resolution: references of a feature
   * that fails before resolving them (`failed`, with `code`) or Refs nested in a direction
   * (`not-reported`). Every other rewritten reference was verified.
   */
  unverified: Array<{ feature: string; field: string; reason: "failed" | "not-reported"; code?: string }>;
}

/** Options of {@link acceptRefCandidate}. */
export interface AcceptRefCandidateOptions {
  /** The candidate's position in the member's `candidates` (split pieces share a key): a non-negative integer. */
  candidateIndex?: number;
  /**
   * The candidate's `probe` as the caller read it from the report: the chosen candidate must
   * still be that entity (same kind, within 5·tol, normal on the same side), else
   * `COMMAND_CANDIDATE_CHANGED`. Without `candidateIndex` it picks the piece among those sharing
   * the key. Pass it whenever the document may have changed since the report was read.
   */
  probe?: Probe;
}

/** An id rewritten by the migration (SPEC-v1 §9.1 rule 3); `from` is untrusted data. */
export type IdRename = metricsV1.IdRename;

/** Result of {@link migrate}. */
export interface MigrateResult {
  /** The canonical `aicad.ir/1` text (SPEC-v1 §0.4), byte-identical to `aicad migrate`. */
  document: string;
  /** Ids the migration rewrote (empty for v1 input and for every v0 document in the repo). */
  renames: IdRename[];
}

/** A parameter's value or failure (the report's `params` block, SPEC-v1 §7.2). */
export type ParamReport = metricsV1.ParamReport;

/** Options of {@link writeBack}. */
export interface WriteBackOptions {
  /** Only these sketch ids (each must be a sketch of the document). Default: every constrained sketch. */
  sketches?: string[];
}

/** A sketch {@link writeBack} did not write. */
export interface WriteBackSkip {
  sketch: string;
  /**
   * `explicit`: no constraints; `suppressed`; `failed`: its evaluation failed with `code`;
   * `would-fail`: it solves, but its written-back solution would fail it with `code` (SPEC-v1
   * §4.4 rule 9 [W0-31]: the weld turns a driving distance ≤ tol into a conflict), so it is
   * withheld and its stored geometry kept.
   */
  reason: "explicit" | "suppressed" | "failed" | "would-fail";
  code?: string;
}

/** Result of {@link writeBack} (`writeBackSolution`, SPEC-v1 §0.6). */
export interface WriteBackResult {
  /**
   * The canonical `aicad.ir/1` text with the solved geometry stored (nothing else changes): the
   * fixed point — writing back again changes nothing (SPEC-v1 §4.4 rule 9 [W0-31]).
   */
  document: string;
  /** `false` when the document was already at its fixed point. */
  changed: boolean;
  /** Sketches written by any pass, in document order. */
  written: string[];
  /** Selected sketches the last pass did not write. */
  skipped: WriteBackSkip[];
  /** Passes run, the confirming one included (1: nothing changed; 3: a solve welded ends). */
  passes: number;
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
  report: AnyEvalReport;
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
  | { type: "frame"; stats: ViewportStats }
  /**
   * The device faulted (`error.code === "RENDER_GPU"`, emitted once): the viewport draws
   * and picks nothing any more. Recreate it (on a new canvas) to recover.
   */
  | { type: "error"; error: ForgeError };

/** Input accepted by {@link init}: a URL of the `.wasm`, its bytes, or a compiled module. */
export type InitInput = string | URL | Request | Response | BufferSource | WebAssembly.Module;

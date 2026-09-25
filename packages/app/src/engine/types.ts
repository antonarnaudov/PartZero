/**
 * Engine-facing types. `RenderBody` and `PickResult` mirror the `@aicad/forge-web` contract
 * exactly, so bodies from any engine can be handed to either viewport adapter unchanged.
 */
import type { EvalReport } from "@aicad/ir-types";
import type { MeshFormat } from "../bridge";
import type { IrCommandEngine } from "../doc/v1/command-engine";

export type { MeshFormat };

export const MESH_FORMATS = ["3mf", "stl", "obj"] as const satisfies readonly MeshFormat[];

/** The triangles of one B-rep face: `indices[3*start .. 3*(start+count))` (as in `@aicad/forge-web`). */
export interface FaceRange {
  /** Provenance name of the B-rep face, e.g. `plate/cap:end` (feature name before the `/`). */
  face: string;
  /** First triangle (a triangle index, not an index-buffer offset). */
  start: number;
  /** Number of triangles. */
  count: number;
}

export interface EdgePolyline {
  /** Provenance name of the B-rep edge, e.g. `plate/edge:{plate/cap:end|plate/side:bottom}`. */
  edge: string;
  /** Polyline points, xyz interleaved. A closed edge repeats its first point at the end. */
  points: Float32Array;
}

/** A tessellated body ready for display (the `@aicad/forge-web` `RenderBody`). */
export interface RenderBody {
  /** Body name, e.g. `plate/plate` (`<part>/<feature>`, `#<n>` suffix when a feature makes several). */
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceRanges: FaceRange[];
  edges: EdgePolyline[];
  /** Optional display colour (sRGB 0..1), e.g. the proposal preview tint. Not produced by engines. */
  color?: [number, number, number];
}

/** What is under the cursor in the viewport. */
export interface PickResult {
  body: string;
  face?: string;
  edge?: string;
}

/** Tessellation tolerances (names as in `@aicad/forge-web`). */
export interface TessellationOptions {
  /** Maximum distance between mesh and exact surface, mm. */
  chordalDeflection?: number;
  /** Maximum normal deviation along a mesh edge, radians. */
  angularDeflection?: number;
}

export interface EvalResult {
  report: EvalReport;
  bodies: RenderBody[];
}

export type EngineId = "forge-web" | "forge-cli" | "none";

/**
 * Evaluates IR documents. Implementations: `ForgeWebEngine` (WASM in a worker), `ForgeCliEngine`
 * (native `aicad` over the desktop bridge), `NullEngine` (no engine: compile-only).
 */
export interface ForgeEngine {
  readonly id: EngineId;
  /** Short label for the status bar, e.g. `Forge CLI · native`. */
  readonly label: string;
  /** Longer description (binary path, backend, reason unavailable). */
  readonly detail: string;
  evaluate(irJson: string): Promise<EvalResult>;
  exportMesh(irJson: string, format: MeshFormat): Promise<Uint8Array>;
  /**
   * The IR v1 command layer's engine entry points (SPEC-v1 §0.6, §5.9, §9.2), when this engine
   * has them (forge-web; the CLI does not yet).
   */
  readonly commands?: IrCommandEngine;
  dispose(): void;
}

export type EngineErrorCode = "ENGINE_UNAVAILABLE" | "ENGINE_FAILED" | "ENGINE_BAD_OUTPUT" | "EXPORT_FAILED";

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

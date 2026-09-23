/**
 * The `@aicad/forge-web` module contract, as agreed with the forge-web workstream. The app codes
 * against this interface and checks the loaded module's shape at runtime ({@link isForgeWebModule})
 * so a drifting or half-built package degrades to the CLI engine + placeholder viewport instead
 * of crashing the shell.
 */
import type { EvalReport } from "@aicad/ir-types";
import type { MeshFormat, PickResult, RenderBody, TessellationOptions } from "./types";

export type ViewName = "iso" | "top" | "front" | "right";
export type Projection = "perspective" | "orthographic";

export interface SectionPlane {
  origin: [number, number, number];
  normal: [number, number, number];
}

export interface ForgeWebViewport {
  setBodies(bodies: RenderBody[]): void;
  /** forge-web returns a richer result (`kind`, `point`, nullable `face`/`edge`, …); see {@link normalizePick}. */
  pick(x: number, y: number): Promise<RawPick | null>;
  setHover(p: PickResult | null): void;
  setSelection(p: PickResult[]): void;
  setSectionPlane(p: SectionPlane | null): void;
  fitView(): void;
  setView(v: ViewName): void;
  setProjection(p: Projection): void;
  /** Wire orbit/pan/zoom. The shell passes `{ hover: false, select: false }`: it drives hover and selection itself. */
  attachControls(target?: HTMLElement, options?: { hover?: boolean; select?: boolean }): unknown;
  resize(w: number, h: number, dpr: number): void;
  dispose(): void;
  backend(): "webgpu" | "webgl2";
}

/** A pick as forge-web reports it: nullable names plus extra fields. */
export interface RawPick {
  body: string;
  face?: string | null;
  edge?: string | null;
  [extra: string]: unknown;
}

/** forge-web pick → the shell's {@link PickResult} (names only, no nulls). */
export function normalizePick(raw: RawPick | null | undefined): PickResult | null {
  if (!raw || typeof raw.body !== "string") return null;
  const out: PickResult = { body: raw.body };
  if (typeof raw.face === "string" && raw.face) out.face = raw.face;
  else if (typeof raw.edge === "string" && raw.edge) out.edge = raw.edge;
  return out;
}

export interface ForgeWebModule {
  init(): Promise<void>;
  evaluate(irJson: string, tess?: TessellationOptions): { report: EvalReport; bodies: RenderBody[] };
  exportMesh(irJson: string, format: MeshFormat): Uint8Array;
  Viewport: {
    create(canvas: HTMLCanvasElement | OffscreenCanvas, options?: object): Promise<ForgeWebViewport>;
  };
}

/** Runtime shape check of a dynamically imported module against {@link ForgeWebModule}. */
export function isForgeWebModule(m: unknown): m is ForgeWebModule {
  if (typeof m !== "object" || m === null) return false;
  const r = m as Record<string, unknown>;
  const viewport = r["Viewport"] as Record<string, unknown> | undefined;
  return (
    typeof r["init"] === "function" &&
    typeof r["evaluate"] === "function" &&
    typeof r["exportMesh"] === "function" &&
    (typeof viewport === "function" || typeof viewport === "object") &&
    viewport !== null &&
    typeof viewport["create"] === "function"
  );
}

/** Which members of the contract a module is missing (for diagnostics). */
export function missingForgeWebMembers(m: unknown): string[] {
  if (typeof m !== "object" || m === null) return ["<module>"];
  const r = m as Record<string, unknown>;
  const missing = ["init", "evaluate", "exportMesh"].filter((k) => typeof r[k] !== "function");
  const viewport = r["Viewport"] as Record<string, unknown> | undefined;
  if (!viewport || typeof viewport["create"] !== "function") missing.push("Viewport.create");
  return missing;
}

/**
 * Export formats (File → Export…): what the export dialog lists and how each one turns the document into bytes.
 * 3MF, STL and OBJ come from the active Forge engine's mesh export. STEP is a registered placeholder until the STEP
 * stream lands its writer: that stream replaces it with one call, `registerExportFormat(stepFormat)`, and the dialog,
 * the command (`file.export { format: "step" }`) and the menu pick it up unchanged.
 */
import type { ForgeEngine, MeshFormat } from "../engine/types";

export interface ExportContext {
  /** The compiled IR (JSON). */
  irJson: string;
  engine: ForgeEngine;
  /** The document's name (the suggested file name). */
  name: string;
}

export interface ExportFormat {
  id: string;
  /** e.g. `3MF`. */
  label: string;
  /** Without the dot; the first one is the default. */
  extensions: string[];
  /** One line for the dialog. */
  description: string;
  /** Whether it can export now, and why not. */
  available(ctx: { engine: ForgeEngine }): { ok: true } | { ok: false; reason: string };
  run(ctx: ExportContext): Promise<Uint8Array>;
}

const formats = new Map<string, ExportFormat>();

/** Add or replace a format; returns a function that restores what was there before. */
export function registerExportFormat(format: ExportFormat): () => void {
  const previous = formats.get(format.id);
  formats.set(format.id, format);
  return () => {
    if (previous) formats.set(format.id, previous);
    else formats.delete(format.id);
  };
}

export function exportFormats(): ExportFormat[] {
  return [...formats.values()];
}

export function exportFormat(id: string): ExportFormat | null {
  return formats.get(id) ?? null;
}

function meshFormat(id: MeshFormat, label: string, description: string): ExportFormat {
  return {
    id,
    label,
    extensions: [id],
    description,
    available: ({ engine }) => (engine.id === "none" ? { ok: false, reason: "No Forge engine is available to tessellate the bodies." } : { ok: true }),
    run: ({ irJson, engine }) => engine.exportMesh(irJson, id),
  };
}

registerExportFormat(meshFormat("3mf", "3MF", "Triangle mesh with units, for slicers (Bambu Studio, PrusaSlicer, Cura)."));
registerExportFormat(meshFormat("stl", "STL", "Plain triangle mesh (binary), accepted everywhere."));
registerExportFormat(meshFormat("obj", "OBJ", "Triangle mesh as text, for renderers and other tools."));
registerExportFormat({
  id: "step",
  label: "STEP",
  extensions: ["step", "stp"],
  description: "Exact B-rep (AP214) for other CAD programs.",
  available: () => ({ ok: false, reason: "Coming with Forge's own STEP writer (planned for build FM5)." }),
  run: () => Promise.reject(new Error("STEP export is not available yet")),
});

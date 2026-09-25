/**
 * The seam between the document layer (saving, opening, recovery) and the document store. The file layer never
 * touches a store directly: it asks a {@link DocumentAdapter} for a snapshot to save and hands it what a file holds to
 * load. {@link DocStoreAdapter} is the adapter for the app's store:
 * - **IR v1** (the document model, when the app has the IR v1 store and an engine with the command layer): every
 *   document opens as an `aicad.ir/1` model — `.partzero` and `.json` files of either IR version (a v0 document is
 *   migrated, SPEC-v1 §9.1), and code-only documents (templates, `.cad.ts` files: CadScript v1 first, else CadScript
 *   v0, migrated). A `.partzero` stores the canonical v1 document, the rollback marker (`view.rollbackMarker`) and the
 *   appearance (`annotations/appearance.json`); no code.
 * - **CadScript / IR v0** (hosts without the IR v1 engine): CadScript source → compiled IR v0, as before.
 */
import { IR_SCHEMA, safeParseIrDocument, v1 as irV1, type IrDocument } from "@aicad/ir-types";
import { blankDocument, rolledBack, type HostState } from "@aicad/model-ops";
import type { CadScriptService } from "../cadscript/service";
import { v1ContentKey, type DocFormat, type DocState, type DocStore } from "../doc/doc-store";
import type { RenderBody } from "../engine/types";
import { BLANK_SOURCE } from "../host/templates";
import { canonicalJson, type DocumentValidator } from "./partzero";

export interface DocumentInfo {
  /** Changes whenever another document is loaded. */
  docId: number;
  name: string;
  path: string | null;
  dirty: boolean;
  /** Changes on every edit. */
  revision: number;
}

/**
 * Exactly what a save (or an autosave) captured, so `markSaved` records that as the saved state and not whatever the
 * store holds by the time the file is written: an edit that lands while a save is in flight stays unsaved.
 */
export interface SaveCapture {
  /** The document the capture was taken from ({@link DocumentInfo.docId}). */
  readonly docId: number;
  /** Its revision at the capture ({@link DocumentInfo.revision}). */
  readonly revision: number;
  /** The captured content, in the adapter's own terms (the CadScript source for {@link DocStoreAdapter}). */
  readonly content: string;
}

/** What `markSaved` did: `clean` (the file holds the document), `changed` (edits landed during the save and are still unsaved), `replaced` (another document was loaded meanwhile; the store was left alone). */
export type MarkSavedResult = "clean" | "changed" | "replaced";

/** What a save needs from the store. */
export interface DocumentSnapshot {
  /** The canonical IR (the normative content), JSON text. */
  documentJson: string;
  /** e.g. `aicad.ir/0`. */
  irSchema: string;
  /** The code view, and whether it compiled to `documentJson`. */
  code: { source: string; matchesDocument: boolean } | null;
  /** Display bodies (for the thumbnail). */
  bodies: readonly RenderBody[];
  capture: SaveCapture;
  /** IR v1 documents: the rollback marker and appearance (saved beside the IR). */
  host?: HostState;
}

/** What a file holds, for the store to load. */
export interface LoadRequest {
  path: string | null;
  name: string;
  /** Canonical IR JSON (null: a code-only document). */
  documentJson: string | null;
  code: { source: string; matchesDocument: boolean } | null;
  /**
   * Recovered unsaved changes: `base` (the document as last saved, when known) is loaded as the saved state and this
   * request's content on top of it as an undoable, unsaved change.
   */
  recoveredFrom?: { base: LoadRequest | null };
  /** The rollback marker and appearance the file holds (IR v1 documents). */
  host?: HostState;
}

export interface DocumentAdapter {
  info(): DocumentInfo;
  subscribe(listener: () => void): () => void;
  /** Resolves when compiling and evaluating settled. */
  idle(): Promise<void>;
  snapshot(): Promise<DocumentSnapshot>;
  /** Load a document; returns warnings for the user (e.g. regenerated code). */
  load(request: LoadRequest): Promise<string[]>;
  /** Load a plain CadScript (`.cad.ts`) or IR JSON (`.json`) file. */
  loadText(path: string, name: string, text: string): Promise<void>;
  /** A new untitled document. */
  loadBlank(name?: string): void;
  /** The text a plain `.cad.ts` or `.json` save writes (IR JSON needs code without errors), and what it captured. */
  textFor(format: "cadscript" | "ir-json"): Promise<{ text: string; capture: SaveCapture }>;
  /** After `path` was written with `capture`'s content: that content is the saved state (see {@link MarkSavedResult}). */
  markSaved(path: string, name: string, capture: SaveCapture): MarkSavedResult;
  /** Validates `document.json` when a `.partzero` is opened. */
  readonly validateDocument: DocumentValidator;
  /** The IR JSON to export (throws when the code has errors). */
  exportIrJson(action: string): Promise<string>;
}

const EMPTY_IR: IrDocument = { schema: IR_SCHEMA, parts: [] };

/** The IR v1 schema id. */
export const IR_V1_SCHEMA = "aicad.ir/1";

/** `plate.partzero`, `plate.cad.ts`, `plate.json` → `plate`. */
export function documentName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const file = i >= 0 ? path.slice(i + 1) : path;
  return file.replace(/\.partzero$/i, "").replace(/\.cad\.ts$/i, "").replace(/\.ts$/i, "").replace(/\.json$/i, "") || file;
}

function formatOf(path: string | null): DocFormat {
  return path && /\.json$/i.test(path) ? "ir-json" : "cadscript";
}

function irText(ir: IrDocument): string {
  return `${JSON.stringify(ir, null, 2)}\n`;
}

function captureOf(s: DocState): SaveCapture {
  return { docId: s.docId, revision: s.revision, content: s.source };
}

function parseIr(json: string): IrDocument {
  const r = safeParseIrDocument(JSON.parse(json) as unknown);
  if (!r.success) throw new Error(`not a valid ${IR_SCHEMA} document: ${r.error.message}`);
  return r.data;
}

/** The adapter for today's store: CadScript source is edited, and compiles to IR v0. */
export class DocStoreAdapter implements DocumentAdapter {
  private readonly doc: DocStore;
  private readonly cadscript: CadScriptService;

  constructor(doc: DocStore, cadscript: CadScriptService) {
    this.doc = doc;
    this.cadscript = cadscript;
  }

  readonly validateDocument: DocumentValidator = (json, irSchema) => {
    if (irSchema === IR_V1_SCHEMA) {
      // The shape here; the engine's rejection pipeline checks the rest when the model loads.
      const r = irV1.IrDocumentSchema.safeParse(json);
      return r.success ? { ok: true } : { ok: false, message: r.error.issues.slice(0, 3).map((i) => `/${i.path.join("/")}: ${i.message}`).join("; ") };
    }
    if (irSchema !== IR_SCHEMA) return { ok: false, message: `this build reads ${IR_V1_SCHEMA} and ${IR_SCHEMA} documents, not ${irSchema}` };
    const r = safeParseIrDocument(json);
    return r.success ? { ok: true } : { ok: false, message: r.error.message };
  };

  info(): DocumentInfo {
    const s = this.doc.getState();
    return { docId: s.docId, name: s.name, path: s.path, dirty: s.dirty, revision: s.revision };
  }

  subscribe(listener: () => void): () => void {
    return this.doc.subscribe(listener);
  }

  async idle(): Promise<void> {
    await this.doc.idle();
  }

  async snapshot(): Promise<DocumentSnapshot> {
    // Everything below comes from this one settled state, so the capture describes exactly what is written.
    const s = await this.doc.idle();
    if (s.format === "ir-v1" && s.v1) {
      const capture: SaveCapture = { docId: s.docId, revision: s.revision, content: v1ContentKey(s.source, s.v1.host) };
      return { documentJson: s.source, irSchema: IR_V1_SCHEMA, code: null, bodies: s.bodies, capture, host: s.v1.host };
    }
    const capture = captureOf(s);
    const c = s.compile;
    if (c?.ok && c.ir) return { documentJson: irText(c.ir), irSchema: IR_SCHEMA, code: { source: s.source, matchesDocument: true }, bodies: s.bodies, capture };
    // The code has errors: the model is the last version that compiled (or empty), and the code is kept as typed.
    return { documentJson: irText(s.model?.ir ?? EMPTY_IR), irSchema: IR_SCHEMA, code: { source: s.source, matchesDocument: false }, bodies: s.bodies, capture };
  }

  private async sourceFor(request: LoadRequest): Promise<{ source: string; baseIr: IrDocument | null; warnings: string[] }> {
    const ir = request.documentJson !== null ? parseIr(request.documentJson) : null;
    if (request.code) return { source: request.code.source, baseIr: ir, warnings: [] };
    if (!ir) return { source: "", baseIr: null, warnings: [] };
    return { source: await this.cadscript.print(ir), baseIr: ir, warnings: [] };
  }

  /**
   * The IR text an IR v1 model opens from, or null when the request is code that compiles neither as CadScript v1
   * nor as CadScript v0 (it then opens as CadScript, errors shown).
   */
  private async v1Text(request: LoadRequest): Promise<{ text: string; warnings: string[] } | null> {
    if (request.documentJson !== null) {
      let schema: unknown;
      try {
        schema = (JSON.parse(request.documentJson) as { schema?: unknown }).schema;
      } catch (e) {
        throw new Error(`the document is not valid JSON: ${(e as Error).message}`);
      }
      const warnings = schema === IR_V1_SCHEMA ? [] : ["This document was made for an earlier model format (IR v0); it opened as an IR v1 model and saves in the new format."];
      return { text: request.documentJson, warnings };
    }
    if (!request.code) return { text: blankDocument(request.name), warnings: [] };
    // CadScript v0 compiles to IR v0 (feature ids = the const names), migrated on load; CadScript v1
    // (parameters, holes, …) compiles with the v1 compiler.
    const v0 = await this.cadscript.compile(request.code.source);
    if (v0.ok && v0.ir) return { text: JSON.stringify(v0.ir), warnings: [] };
    const v1 = await this.cadscript.compileV1(request.code.source);
    if (v1.ok && v1.irJson) return { text: v1.irJson, warnings: [] };
    return null;
  }

  async load(request: LoadRequest): Promise<string[]> {
    if (this.doc.v1Available) {
      const plan = await this.v1Text(request);
      if (plan) {
        const base = request.recoveredFrom ? (request.recoveredFrom.base ? await this.v1Text(request.recoveredFrom.base) : { text: blankDocument(request.name), warnings: [] }) : null;
        this.doc.load({
          path: request.path,
          name: request.name,
          format: "ir-v1",
          source: plan.text,
          ...(request.host ? { host: request.host } : {}),
          ...(base ? { savedV1: { source: base.text, ...(request.recoveredFrom?.base?.host ? { host: request.recoveredFrom.base.host } : {}) } } : {}),
        });
        const s = await this.doc.idle();
        if (s.engineError && s.model === null) throw new Error(s.engineError);
        return plan.warnings;
      }
    }
    const warnings: string[] = [];
    const format = formatOf(request.path);
    if (request.recoveredFrom) {
      const base = request.recoveredFrom.base ? await this.sourceFor(request.recoveredFrom.base) : { source: "", baseIr: null, warnings: [] };
      this.doc.load({ path: request.path, name: request.name, format, source: base.source, ...(base.baseIr ? { baseIr: base.baseIr } : {}) });
      const recovered = await this.sourceFor(request);
      if (!this.doc.setSource(recovered.source, { label: "Recovered changes", origin: "user" })) {
        warnings.push("The recovered document has no changes compared with the saved file.");
      }
      await this.doc.idle();
      return warnings;
    }
    const { source, baseIr } = await this.sourceFor(request);
    this.doc.load({ path: request.path, name: request.name, format, source, ...(baseIr ? { baseIr } : {}) });
    const s = await this.doc.idle();
    if (request.code && request.documentJson !== null) {
      if (request.code.matchesDocument) {
        // The code must still compile to the saved model (SPEC: document.json is normative); if it does not, the
        // model wins and the code is printed from it again.
        const compiled = s.compile?.ok && s.compile.ir ? canonicalJson(s.compile.ir) : null;
        if (compiled !== canonicalJson(JSON.parse(request.documentJson))) {
          const ir = parseIr(request.documentJson);
          const printed = await this.cadscript.print(ir);
          this.doc.load({ path: request.path, name: request.name, format, source: printed, baseIr: ir });
          await this.doc.idle();
          warnings.push("The code in this file did not match its model, so it was regenerated from the model (its comments are lost).");
        }
      } else {
        warnings.push("This document was saved while its code had errors: the code is as you left it; fix the errors to see the model again.");
      }
    }
    return warnings;
  }

  async loadText(path: string, name: string, text: string): Promise<void> {
    if (this.doc.v1Available) {
      const isJson = /\.json$/i.test(path);
      if (isJson) {
        try {
          JSON.parse(text);
        } catch (e) {
          throw new Error(`${name} is not valid JSON: ${(e as Error).message}`);
        }
      }
      await this.load({ path, name, documentJson: isJson ? text : null, code: isJson ? null : { source: text, matchesDocument: false } });
      return;
    }
    if (/\.json$/i.test(path)) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error(`${name} is not valid JSON: ${(e as Error).message}`);
      }
      const parsed = safeParseIrDocument(json);
      if (!parsed.success) throw new Error(`${name} is not an ${IR_SCHEMA} document: ${parsed.error.message}`);
      const source = await this.cadscript.print(parsed.data);
      this.doc.load({ path, name, format: "ir-json", source, baseIr: parsed.data });
    } else {
      this.doc.load({ path, name, format: "cadscript", source: text });
    }
  }

  loadBlank(name = "untitled"): void {
    if (this.doc.v1Available) this.doc.load({ path: null, name, format: "ir-v1", source: blankDocument(name) });
    else this.doc.load({ path: null, name, format: "cadscript", source: BLANK_SOURCE });
  }

  async textFor(format: "cadscript" | "ir-json"): Promise<{ text: string; capture: SaveCapture }> {
    const v = await this.doc.idle();
    if (v.format === "ir-v1" && v.v1) {
      const capture: SaveCapture = { docId: v.docId, revision: v.revision, content: v1ContentKey(v.source, v.v1.host) };
      if (format === "ir-json") return { text: v.source.endsWith("\n") ? v.source : `${v.source}\n`, capture };
      const code = await this.cadscript.printV1(v.source);
      if (code === null) throw new Error("This model cannot be written as CadScript; save it as .partzero or .json.");
      return { text: code, capture };
    }
    if (format === "cadscript") {
      const s = this.doc.getState();
      return { text: s.source, capture: captureOf(s) };
    }
    const { s, ir } = await this.compiled("save as IR JSON");
    return { text: irText(ir), capture: captureOf(s) };
  }

  markSaved(path: string, name: string, capture: SaveCapture): MarkSavedResult {
    if (this.doc.getState().docId !== capture.docId) return "replaced";
    this.doc.markSaved({ path, name, format: formatOf(path), savedSource: capture.content });
    return this.doc.getState().dirty ? "changed" : "clean";
  }

  async exportIrJson(action: string): Promise<string> {
    const s = await this.doc.idle();
    // An IR v1 model exports what is built: the document up to its rollback marker.
    if (s.format === "ir-v1" && s.v1) return rolledBack(s.source, s.v1.host.rollback);
    return JSON.stringify((await this.compiled(action)).ir);
  }

  /** The settled state and its compiled IR (throws when the code has errors). */
  private async compiled(action: string): Promise<{ s: DocState; ir: IrDocument }> {
    const s = await this.doc.idle();
    const c = s.compile;
    if (!c?.ok || !c.ir) {
      const n = c?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
      throw new Error(`Cannot ${action}: the code has ${n} error${n === 1 ? "" : "s"}. Fix them first.`);
    }
    return { s, ir: c.ir };
  }
}

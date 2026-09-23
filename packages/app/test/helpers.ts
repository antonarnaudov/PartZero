import type { EvalReport, FeatureReport, IrDocument } from "@aicad/ir-types";
import type { AppInfo, DocumentStateMessage, MenuCommandMessage, OpenDialogOptions, SaveDialogOptions } from "../src/bridge";
import { InlineCadScriptService } from "../src/cadscript/inline-service";
import { createCommandRegistry, type AppCommandRegistry } from "../src/commands/commands";
import { DocStore } from "../src/doc/doc-store";
import { EngineManager } from "../src/engine/engine-manager";
import type { EvalResult, ForgeEngine, MeshFormat, RenderBody } from "../src/engine/types";
import type { AppHost } from "../src/host/host";
import { TEMPLATES } from "../src/host/templates";
import { EditorController, ViewportController, type AppServices, type EditorApi } from "../src/services";
import { UiStore } from "../src/ui-store";

export const HEADER = 'import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";\n';

export const BOX = `${HEADER}
part("plate");
// The outline.
const outline = sketch(XY, {
  bottom: line([-25, -25], [25, -25]),
  right: line([25, -25], [25, 25]),
  top: line([25, 25], [-25, 25]),
  left: line([-25, 25], [-25, -25]),
});
const plate = extrude(outline, { distance: 5 });
`;

/** A body for every extrude/revolve, with provenance-style face names. */
function fakeBody(part: string, feature: string): RenderBody {
  return {
    name: `${part}/${feature}`,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    normals: new Float32Array(12),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3]),
    faceRanges: [
      { face: `${feature}/cap:start`, start: 0, count: 1 },
      { face: `${feature}/side:bottom`, start: 1, count: 1 },
    ],
    edges: [],
  };
}

/**
 * A deterministic stand-in for Forge: every feature is "ok" except sketches whose curve ids
 * include `dangling` (reported as SKETCH_OPEN_LOOP) and their dependents.
 */
export class FakeEngine implements ForgeEngine {
  readonly id = "forge-cli" as const;
  readonly label = "Fake engine";
  readonly detail = "test double";
  evaluations: string[] = [];
  exports: Array<{ irJson: string; format: MeshFormat }> = [];
  /** When set, `evaluate` waits for this promise before answering. */
  gate: (() => Promise<void>) | null = null;
  fail: string | null = null;

  async evaluate(irJson: string): Promise<EvalResult> {
    this.evaluations.push(irJson);
    if (this.gate) await this.gate();
    if (this.fail) throw new Error(this.fail);
    const ir = JSON.parse(irJson) as IrDocument;
    const features: FeatureReport[] = [];
    const bodies: RenderBody[] = [];
    const failed = new Set<string>();
    for (const part of ir.parts) {
      for (const f of part.features) {
        if (f.suppressed) continue;
        if (f.type === "sketch") {
          if (f.curves.some((c) => c.id.includes("dangling"))) {
            failed.add(f.id);
            features.push({ part: part.name, feature: f.name, type: f.type, status: "error", error: { code: "SKETCH_OPEN_LOOP", message: `curve end of ${f.name} meets no other curve end` } });
          } else {
            features.push({ part: part.name, feature: f.name, type: f.type, status: "ok", regions: [] });
          }
        } else if (failed.has(f.sketch)) {
          features.push({ part: part.name, feature: f.name, type: f.type, status: "error", error: { code: "DEPENDENCY_FAILED", message: "sketch failed" } });
        } else {
          features.push({ part: part.name, feature: f.name, type: f.type, status: "ok", bodies: [] });
          bodies.push(fakeBody(part.name, f.name));
        }
      }
    }
    const report: EvalReport = {
      schema: "aicad.metrics/0",
      engine: "fake",
      document: ir.meta?.name ?? "doc",
      status: features.some((f) => f.status === "error") ? "error" : "ok",
      features,
    };
    return { report, bodies };
  }

  exportMesh(irJson: string, format: MeshFormat): Promise<Uint8Array> {
    this.exports.push({ irJson, format });
    return Promise.resolve(new TextEncoder().encode(`PK-fake-${format}`));
  }

  dispose(): void {}
}

export class FakeHost implements AppHost {
  readonly kind = "browser" as const;
  readonly platform = "test";
  readonly forgeCli = null;
  files = new Map<string, string | Uint8Array>();
  nextOpenPath: string | null = null;
  nextSavePath: string | null = null;
  recent: string[] = [];
  docStates: DocumentStateMessage[] = [];
  saveDialogs: SaveDialogOptions[] = [];

  appInfo(): Promise<AppInfo> {
    return Promise.resolve({
      name: "aicad",
      version: "0.0.0-test",
      electron: "-",
      chrome: "-",
      node: "-",
      platform: "test",
      arch: "-",
      isDev: true,
      forgeCli: { available: false, path: "", detail: "" },
    });
  }
  pickOpenPath(_o: OpenDialogOptions): Promise<string | null> {
    return Promise.resolve(this.nextOpenPath);
  }
  pickSavePath(o: SaveDialogOptions): Promise<string | null> {
    this.saveDialogs.push(o);
    return Promise.resolve(this.nextSavePath);
  }
  readTextFile(path: string): Promise<string> {
    const f = this.files.get(path);
    if (typeof f !== "string") return Promise.reject(new Error(`ENOENT ${path}`));
    if (!this.recent.includes(path)) this.recent.unshift(path);
    return Promise.resolve(f);
  }
  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.files.set(path, data);
    if (!this.recent.includes(path)) this.recent.unshift(path);
    return Promise.resolve();
  }
  recentFiles(): Promise<string[]> {
    return Promise.resolve([...this.recent]);
  }
  clearRecentFiles(): Promise<void> {
    this.recent = [];
    return Promise.resolve();
  }
  setDocumentState(s: DocumentStateMessage): void {
    this.docStates.push(s);
  }
  onMenuCommand(_l: (m: MenuCommandMessage) => void): () => void {
    return () => undefined;
  }
}

export interface Harness {
  services: AppServices;
  commands: AppCommandRegistry;
  engine: FakeEngine;
  host: FakeHost;
  reveals: Array<{ line: number; select: boolean }>;
  confirmAnswer: { value: boolean };
}

export async function makeHarness(options: { source?: string } = {}): Promise<Harness> {
  const engine = new FakeEngine();
  const engines = new EngineManager({ "forge-cli": () => Promise.resolve(engine) });
  await engines.select("auto");
  const cadscript = new InlineCadScriptService();
  const doc = new DocStore({ cadscript, engine: () => engines.active, debounceMs: 0 });
  const host = new FakeHost();
  const reveals: Harness["reveals"] = [];
  const editor = new EditorController();
  const api: EditorApi = {
    reveal: (span, o) => reveals.push({ line: span.start.line, select: o.select }),
    focus: () => undefined,
  };
  editor.attach(api);
  const confirmAnswer = { value: true };
  const services: AppServices = {
    doc,
    ui: new UiStore(),
    host,
    engines,
    cadscript,
    editor,
    viewport: new ViewportController(),
    templates: TEMPLATES,
    confirm: () => Promise.resolve(confirmAnswer.value),
  };
  const commands = createCommandRegistry(() => services);
  if (options.source !== undefined) {
    doc.load({ path: null, name: "test", format: "cadscript", source: options.source });
    await doc.idle();
  }
  return { services, commands, engine, host, reveals, confirmAnswer };
}

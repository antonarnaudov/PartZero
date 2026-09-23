/**
 * Composition root: picks the host (Electron bridge or browser), starts the CadScript worker,
 * selects the engine (forge-web → Forge CLI → none), creates the stores and the command registry,
 * and connects the native menu and the automation hook.
 */
import type { CadScriptService } from "./cadscript/service";
import { WorkerCadScriptService } from "./cadscript/worker-service";
import { createCommandRegistry, type AppCommandRegistry } from "./commands/commands";
import type { CommandInfo, CommandResult } from "./commands/registry";
import { DocStore } from "./doc/doc-store";
import { collectProblems } from "./doc/problems";
import { findFeature } from "./doc/provenance";
import { EngineManager, type EngineFactories } from "./engine/engine-manager";
import { ForgeCliEngine } from "./engine/forge-cli-engine";
import { ForgeWebEngine, forgeWebBundled, forgeWebSource } from "./engine/forge-web-engine";
import { BrowserHost } from "./host/browser-host";
import { ElectronHost } from "./host/electron-host";
import type { AppHost } from "./host/host";
import { BLANK_SOURCE, TEMPLATES } from "./host/templates";
import { EditorController, ViewportController, type AppServices } from "./services";
import { UiStore } from "./ui-store";

/** `window.__aicad`: a small automation surface over the command layer (e2e tests, debugging). */
export interface AutomationApi {
  execute(cmd: unknown): Promise<CommandResult<unknown>>;
  describe(): CommandInfo[];
  /** Resolves when compile + evaluation settled; returns a JSON summary of the document. */
  idle(): Promise<DocSummary>;
  summary(): DocSummary;
}

export interface DocSummary {
  name: string;
  path: string | null;
  dirty: boolean;
  phase: string;
  engine: string;
  reportStatus: string | null;
  features: Array<{ part: string; name: string; type: string; status: string | null }>;
  bodies: Array<{ name: string; faces: string[]; triangles: number; edges: number }>;
  problems: Array<{ code: string; severity: string; message: string }>;
  evalMs: number | null;
  selection: { feature: string | null; entity: { body: string; face?: string; edge?: string } | null };
}

declare global {
  interface Window {
    __aicad?: AutomationApi;
  }
}

export interface Bootstrapped {
  services: AppServices;
  commands: AppCommandRegistry;
}

function createHost(): AppHost {
  return window.aicad ? new ElectronHost(window.aicad) : new BrowserHost();
}

async function createCadScriptService(): Promise<CadScriptService> {
  if (typeof Worker !== "undefined") {
    try {
      return new WorkerCadScriptService();
    } catch {
      // fall through to the inline service
    }
  }
  // Lazy: keeps the TypeScript compiler out of the main chunk when workers are available.
  const { InlineCadScriptService } = await import("./cadscript/inline-service");
  return new InlineCadScriptService();
}

function summarize(services: AppServices): DocSummary {
  const s = services.doc.getState();
  const byName = new Map((s.report?.features ?? []).map((f) => [`${f.part}/${f.feature}`, f.status]));
  return {
    name: s.name,
    path: s.path,
    dirty: s.dirty,
    phase: s.phase,
    engine: services.engines.active.id,
    reportStatus: s.report?.status ?? null,
    features: (s.model?.ir?.parts ?? []).flatMap((p) =>
      p.features.map((f) => ({ part: p.name, name: f.name, type: f.type, status: byName.get(`${p.name}/${f.name}`) ?? null })),
    ),
    bodies: s.bodies.map((b) => ({
      name: b.name,
      faces: [...new Set(b.faceRanges.map((r) => r.face))],
      triangles: b.indices.length / 3,
      edges: b.edges.length,
    })),
    problems: collectProblems(s).map((p) => ({ code: p.code, severity: p.severity, message: p.message })),
    evalMs: s.timings.evalMs,
    selection: {
      feature: s.selection.featureId ? (findFeature(s.model?.ir, s.selection.featureId)?.feature.name ?? null) : null,
      entity: s.selection.entity,
    },
  };
}

export async function bootstrap(): Promise<Bootstrapped> {
  const host = createHost();
  const cadscript = await createCadScriptService();

  const factories: EngineFactories = {};
  if (forgeWebBundled) factories["forge-web"] = () => ForgeWebEngine.create();
  const cli = host.forgeCli;
  if (cli) {
    factories["forge-cli"] = async () => {
      const info = await cli.info();
      if (!info.available) throw new Error(info.detail);
      return new ForgeCliEngine(cli, info);
    };
  }
  const engines = new EngineManager(factories, {
    "forge-web": `not bundled (${forgeWebSource})`,
    "forge-cli": "only available in the desktop app",
  });

  const ui = new UiStore();
  const doc = new DocStore({ cadscript, engine: () => engines.active });
  const services: AppServices = {
    doc,
    ui,
    host,
    engines,
    cadscript,
    editor: new EditorController(),
    viewport: new ViewportController(),
    templates: TEMPLATES,
    confirm: (message) => Promise.resolve(window.confirm(message)),
  };
  const commands = createCommandRegistry(() => services);

  // Failures of user-initiated commands surface as toasts; programmatic callers get the result.
  commands.onDidExecute((r) => {
    if (!r.ok && r.error && (r.source === "ui" || r.source === "keyboard" || r.source === "menu" || r.source === "palette")) {
      ui.toast("error", r.error.message);
    }
    if (import.meta.env.DEV) console.debug(`[command] ${r.id} (${r.source}) ${r.ok ? "ok" : r.error?.code} ${r.ms} ms`);
  });

  host.onMenuCommand((m) => void commands.executeUnknown({ id: m.id, args: m.args ?? {} }, { source: "menu" }));

  // Window title, dirty marker and the close prompt live in the shell.
  let lastDocState = "";
  const pushDocState = (): void => {
    const s = doc.getState();
    const key = `${s.name}\u0000${s.path ?? ""}\u0000${s.dirty}`;
    if (key === lastDocState) return;
    lastDocState = key;
    host.setDocumentState({ title: s.name, path: s.path, dirty: s.dirty });
  };
  doc.subscribe(pushDocState);
  pushDocState();

  try {
    globalThis.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", () => ui.refreshSystemTheme());
  } catch {
    // ignore
  }
  void host.appInfo().then((info) => ui.setAppInfo(info), () => undefined);
  void host.recentFiles().then((r) => ui.setRecentFiles(r), () => undefined);

  window.__aicad = {
    execute: (cmd) => commands.executeUnknown(cmd, { source: "test" }),
    describe: () => commands.describe(),
    idle: async () => {
      await doc.idle();
      return summarize(services);
    },
    summary: () => summarize(services),
  };

  // Pick the engine before the first evaluation, then open the starter document.
  await engines.select("auto");
  doc.load({ path: null, name: "untitled", format: "cadscript", source: BLANK_SOURCE });
  return { services, commands };
}

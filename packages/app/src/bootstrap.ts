/**
 * Composition root: picks the host (Electron bridge or browser), starts the CadScript worker,
 * selects the engine (forge-web → Forge CLI → none), creates the stores and the command registry,
 * and connects the native menu and the automation hook.
 */
import { AgentService } from "./agent/agent-service";
import type { CadScriptService } from "./cadscript/service";
import { WorkerCadScriptService } from "./cadscript/worker-service";
import { createCommandRegistry, type AppCommandRegistry } from "./commands/commands";
import type { CommandInfo, CommandResult } from "./commands/registry";
import { DocStore } from "./doc/doc-store";
import { IrDocStore } from "./doc/v1/ir-doc-store";
import { collectProblems } from "./doc/problems";
import { findFeature } from "./doc/provenance";
import { EngineManager, type EngineFactories } from "./engine/engine-manager";
import { ForgeCliEngine } from "./engine/forge-cli-engine";
import { ForgeWebEngine, forgeWebBundled, forgeWebSource } from "./engine/forge-web-engine";
import { BrowserHost } from "./host/browser-host";
import { ElectronHost } from "./host/electron-host";
import type { AppHost } from "./host/host";
import { BLANK_SOURCE, TEMPLATES } from "./host/templates";
import { blankDocument, type IrOp } from "@aicad/model-ops";
import { appOpsHost } from "./agent/ops-host";
import { EditorController, ViewportController, type AppServices } from "./services";
import { UiStore } from "./ui-store";

/**
 * `window.__aicad`: a small automation surface over the command layer (e2e tests, debugging).
 * Installed only in development: a Vite dev build, or an unpackaged desktop run (`AppInfo.isDev`,
 * which is how the Playwright e2e suite launches the app). A packaged or production build has no
 * such global, so nothing pasted into a console can drive the command layer through it.
 */
export interface AutomationApi {
  execute(cmd: unknown): Promise<CommandResult<unknown>>;
  describe(): CommandInfo[];
  /** Resolves when compile + evaluation settled; returns a JSON summary of the document. */
  idle(): Promise<DocSummary>;
  summary(): DocSummary;
  /** The agent's state: active run, last run, proposal under review. */
  agent(): AgentSummary;
  /**
   * The live document as an op host (`@aicad/model-ops` `OpsHost`), as the agent's op tools see it:
   * `ops.apply([{ op: "addFeature", … }])` runs through the command layer as the agent.
   */
  ops: { document(): Promise<string>; apply(ops: unknown[], options?: { label?: string; ack?: string[] }): Promise<unknown> };
}

export interface AgentSummary {
  available: boolean;
  activeRunId: string | null;
  lastRun: { runId: string; status: string; phases: string[]; spentUsd: number; budgetUsd: number; result: { status: string; stopReason: string; changed: boolean } | null; error: string | null } | null;
  review: {
    status: string;
    changes: Array<{ key: string; kind: string; summary: string }>;
    accepted: string[];
    warnings: string[];
    /** CadScript of the ticked changes (the right side of the diff). */
    variantSource: string;
    previewEnabled: boolean;
    preview: string;
    resolution: string | null;
  } | null;
  codeTab: string;
}

export interface DocSummary {
  name: string;
  /** `ir-v1` (the document model), or `cadscript` / `ir-json` (IR v0). */
  format: string;
  /** IR v1: the rollback marker and appearance. */
  rollback: string | null;
  path: string | null;
  dirty: boolean;
  phase: string;
  engine: string;
  reportStatus: string | null;
  features: Array<{ part: string; name: string; type: string; status: string | null; id: string; author: "user" | "agent" }>;
  bodies: Array<{ name: string; faces: string[]; triangles: number; edges: number }>;
  problems: Array<{ code: string; severity: string; message: string }>;
  evalMs: number | null;
  selection: { feature: string | null; entity: { body: string; face?: string; edge?: string } | null };
  /** Overall bounding box of every body in the report (mm), null without bodies. */
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
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

function reportBbox(s: ReturnType<AppServices["doc"]["getState"]>): DocSummary["bbox"] {
  let min: [number, number, number] | null = null;
  let max: [number, number, number] | null = null;
  for (const f of s.report?.features ?? []) {
    for (const b of f.bodies ?? []) {
      min = min ? [Math.min(min[0], b.bbox_min[0]), Math.min(min[1], b.bbox_min[1]), Math.min(min[2], b.bbox_min[2])] : [...b.bbox_min];
      max = max ? [Math.max(max[0], b.bbox_max[0]), Math.max(max[1], b.bbox_max[1]), Math.max(max[2], b.bbox_max[2])] : [...b.bbox_max];
    }
  }
  return min && max ? { min, max } : null;
}

function summarizeAgent(services: AppServices): AgentSummary {
  const a = services.agent.getState();
  const last = a.runs[a.runs.length - 1];
  const r = a.review;
  return {
    available: a.available,
    activeRunId: a.activeRunId,
    lastRun: last
      ? {
          runId: last.runId,
          status: last.status,
          phases: last.phases,
          spentUsd: last.spentUsd,
          budgetUsd: last.budgetUsd,
          result: last.result ? { status: last.result.status, stopReason: last.result.stopReason, changed: last.result.changed } : null,
          error: last.error?.message ?? null,
        }
      : null,
    review: r
      ? {
          status: r.status,
          changes: r.changes.map((c) => ({ key: c.key, kind: c.kind, summary: c.summary })),
          accepted: r.accepted,
          warnings: r.warnings.map((w) => `${w.severity}: ${w.message}`),
          variantSource: r.variantSource,
          previewEnabled: r.previewEnabled,
          preview: r.preview.status,
          resolution: r.resolution?.kind ?? null,
        }
      : null,
    codeTab: a.codeTab,
  };
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
    format: s.format,
    rollback: s.v1?.host.rollback ?? null,
    features: (s.model?.ir?.parts ?? []).flatMap((p) =>
      p.features.map((f) => ({
        part: p.name,
        name: f.name,
        type: f.type,
        status: byName.get(`${p.name}/${f.name}`) ?? null,
        id: f.id,
        author: (f as { author?: string }).author === "agent" ? "agent" : "user",
      })),
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
    bbox: reportBbox(s),
  };
}

/** Whether to install `window.__aicad`: a dev build, or a host that reports an unpackaged (dev) run. */
export function automationAllowed(devBuild: boolean, info: { isDev: boolean } | null): boolean {
  return devBuild || info?.isDev === true;
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

  const ui = new UiStore({ agentAvailable: host.agent !== null });
  // The IR v1 store is the document of record of IR v1 documents (the app's document model); the
  // DocStore mirrors it for the UI (timeline, viewport, files) and evaluates it.
  const ir = new IrDocStore({ engine: () => engines.active.commands ?? null });
  const doc = new DocStore({ cadscript, engine: () => engines.active, ir });
  const agent = new AgentService({ agent: host.agent, settings: host.settings, cadscript, engine: () => engines.active, doc, ui });
  const services: AppServices = {
    doc,
    ui,
    host,
    engines,
    cadscript,
    editor: new EditorController(),
    viewport: new ViewportController(),
    templates: TEMPLATES,
    agent,
    ir,
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
  const info = await host.appInfo().catch(() => null);
  if (info) ui.setAppInfo(info);
  void host.recentFiles().then((r) => ui.setRecentFiles(r), () => undefined);

  if (automationAllowed(import.meta.env.DEV, info)) {
    window.__aicad = {
      execute: (cmd) => commands.executeUnknown(cmd, { source: "test" }),
      describe: () => commands.describe(),
      idle: async () => {
        await doc.idle();
        return summarize(services);
      },
      summary: () => summarize(services),
      agent: () => summarizeAgent(services),
      ops: (() => {
        const host = appOpsHost(services, commands, "agent");
        return { document: () => host.document(), apply: (ops, options) => host.apply(ops as IrOp[], options) };
      })(),
    };
  }

  // Pick the engine before the first evaluation, then open the starter document.
  await engines.select("auto");
  // New documents are IR v1 models; a host whose engine has no IR v1 command layer starts CadScript (IR v0).
  if (doc.v1Available) doc.load({ path: null, name: "untitled", format: "ir-v1", source: blankDocument("untitled") });
  else doc.load({ path: null, name: "untitled", format: "cadscript", source: BLANK_SOURCE });
  return { services, commands };
}

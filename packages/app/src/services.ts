/**
 * The services every command runs against (the command context), plus thin controllers through
 * which commands reach UI surfaces that React owns (the code editor and the viewport).
 */
import type { Span } from "@aicad/cadscript";
import type { AgentService } from "./agent/agent-service";
import type { CadScriptService } from "./cadscript/service";
import type { DocStore } from "./doc/doc-store";
import type { IrDocStore } from "./doc/v1/ir-doc-store";
import type { EngineManager } from "./engine/engine-manager";
import type { Projection, ViewName } from "./engine/forge-web-contract";
import type { AppHost } from "./host/host";
import type { TemplateInfo } from "./host/templates";
import type { UiStore } from "./ui-store";

export interface EditorApi {
  reveal(span: Span, options: { select: boolean; focus: boolean }): void;
  focus(): void;
}

export class EditorController {
  private api: EditorApi | null = null;

  attach(api: EditorApi): () => void {
    this.api = api;
    return () => {
      if (this.api === api) this.api = null;
    };
  }

  reveal(span: Span, options: { select?: boolean; focus?: boolean } = {}): void {
    this.api?.reveal(span, { select: options.select ?? false, focus: options.focus ?? false });
  }

  focus(): void {
    this.api?.focus();
  }
}

export interface ViewportApi {
  fitView(): void;
  setView(view: ViewName): void;
  setProjection(projection: Projection): void;
}

export class ViewportController {
  private api: ViewportApi | null = null;

  attach(api: ViewportApi): () => void {
    this.api = api;
    return () => {
      if (this.api === api) this.api = null;
    };
  }

  fitView(): void {
    this.api?.fitView();
  }

  setView(view: ViewName): void {
    this.api?.setView(view);
  }

  setProjection(projection: Projection): void {
    this.api?.setProjection(projection);
  }
}

export interface AppServices {
  doc: DocStore;
  ui: UiStore;
  host: AppHost;
  engines: EngineManager;
  cadscript: CadScriptService;
  editor: EditorController;
  viewport: ViewportController;
  templates: readonly TemplateInfo[];
  /** The design agent: runs, proposal review, settings. */
  agent: AgentService;
  /**
   * The IR v1 document store and its command-layer ops (setParam, writeBackSolution, captureRef,
   * reference repairs, renames, upgrades; SPEC-v1 §0.6, §5.9). Absent on hosts without it.
   */
  ir?: IrDocStore;
  /** Ask the user to confirm (e.g. discarding unsaved changes). Agents/tests inject a policy. */
  confirm(message: string): Promise<boolean>;
}

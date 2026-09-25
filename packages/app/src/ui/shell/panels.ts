/**
 * The panel registry (plan §2.5 "Layout", §3.3): the tabs of the left dock (Timeline, and e.g. the
 * Browser) and the right dock (the property panel, Code, the agent's Proposal). A workstream adds a
 * panel with one `registerPanel({ … })` line in `ui/shell/panel-catalog.tsx`.
 *
 * - `left`: model structure (timeline, browser, parameters).
 * - `right`: the tool's property panel, the code, the proposal. The chat (Assistant) sits under the
 *   right dock, and Problems under the workspace; they are fixed parts of the layout.
 */
import type { ComponentType } from "react";
import type { AppServices } from "../../services";
import type { Shell } from "../../tools/shell";
import { Store } from "../../store";

export type PanelArea = "left" | "right";

export interface PanelContext {
  services: AppServices;
  shell: Shell;
}

export interface PanelDefinition {
  /** Unique id, e.g. `timeline`, `browser`, `code`. */
  id: string;
  title: string;
  /** An icon name from `ui/shell/tool-icons.tsx` or the app icon set (`Timeline`, `Code`, …). */
  icon?: string;
  area: PanelArea;
  /** Tab order (default 100). */
  order?: number;
  component: ComponentType;
  /**
   * Keep the component mounted while its tab is hidden (the code editor keeps its Monaco state).
   * Default false.
   */
  keepMounted?: boolean;
  /** Show the tab only when this holds (e.g. the proposal tab while there is a proposal). */
  visibleWhen?(ctx: PanelContext): boolean;
  /** A small marker on the tab: a count, `""` for a dot, or null for none. */
  badge?(ctx: PanelContext): string | null;
  /** Shown at the right end of the tab strip while the panel is the active tab (a file name, a status pill). */
  headerExtra?: ComponentType;
  /** `data-testid` of its tab (default `dock-tab-<id>`). */
  tabTestId?: string;
}

export class PanelRegistry extends Store<{ panels: readonly PanelDefinition[] }> {
  constructor() {
    super({ panels: [] });
  }

  register(def: PanelDefinition): () => void {
    if (!/^[a-z][A-Za-z0-9.-]*$/.test(def.id)) throw new Error(`panel id "${def.id}" must be a lower-case identifier`);
    if (this.getState().panels.some((p) => p.id === def.id)) throw new Error(`a panel with id ${def.id} is already registered`);
    this.setState((s) => ({
      panels: [...s.panels, def].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title)),
    }));
    return () => this.setState((s) => ({ panels: s.panels.filter((p) => p.id !== def.id) }));
  }

  get(id: string): PanelDefinition | undefined {
    return this.getState().panels.find((p) => p.id === id);
  }

  inArea(area: PanelArea): PanelDefinition[] {
    return this.getState().panels.filter((p) => p.area === area);
  }
}

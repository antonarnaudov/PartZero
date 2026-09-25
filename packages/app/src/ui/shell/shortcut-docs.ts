/**
 * Extra sections of the keyboard-shortcuts map for input that is not a command key: viewport
 * navigation (mouse, trackpad), panel keys. Commands and tools list themselves from their registries;
 * the viewport owner describes its gestures here, replacing a section by id when they change.
 */
import { Store } from "../../store";

export interface ShortcutRow {
  /** What to press or do, as shown (`Right-drag`, `Pinch`, `⏎`). */
  keys: string;
  label: string;
}

export interface ShortcutSection {
  id: string;
  title: string;
  rows: readonly ShortcutRow[];
  order?: number;
}

export class ShortcutDocs extends Store<{ sections: readonly ShortcutSection[] }> {
  constructor(initial: readonly ShortcutSection[] = []) {
    super({ sections: [...initial] });
  }

  /** Add a section, or replace the one with the same id. */
  set(section: ShortcutSection): void {
    this.setState((s) => ({
      sections: [...s.sections.filter((x) => x.id !== section.id), section].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
    }));
  }
}

/** Keys inside an open property panel (plan §2.5). */
export const PANEL_KEYS: ShortcutSection = {
  id: "panel",
  title: "In a tool panel",
  order: 10,
  rows: [
    { keys: "⏎", label: "OK: apply the change and close" },
    { keys: "Esc", label: "Cancel: close without changing anything" },
    { keys: "Tab", label: "Next field" },
    { keys: "↑ ↓", label: "Step a number (⇧ ×10, ⌥ ×0.1)" },
    { keys: "12 mm, 0.5 in, 30°, wall*2", label: "Numbers take units and parameter expressions" },
  ],
};

/** The timeline under the viewport (ui/model/TimelineBar.tsx). */
export const TIMELINE_KEYS: ShortcutSection = {
  id: "timeline",
  title: "Timeline",
  order: 15,
  rows: [
    { keys: "Click · double-click", label: "Select a feature · edit it (a sketch opens in sketch mode)" },
    { keys: "Drag a feature", label: "Reorder: the line is green where it may go, red with the reason where not" },
    { keys: "Drag the marker ▼", label: "Roll the model back (features after it are not built)" },
    { keys: "Right-click", label: "Rename, suppress, roll back here, move, keep, delete" },
    { keys: "← →", label: "Previous / next feature (timeline focused)" },
    { keys: "⏎ · F2 · ⌫", label: "Edit · rename · delete (timeline focused)" },
  ],
};

/**
 * The viewport's navigation as `@aicad/forge-web`'s controls implement it today
 * (`ForgeViewport.attachControls`). The viewport workstream replaces this section (same id) when the
 * FD3 navigation (trackpad and mouse presets) lands.
 */
export const VIEWPORT_NAVIGATION: ShortcutSection = {
  id: "navigation",
  title: "Viewport",
  order: 20,
  rows: [
    { keys: "Drag / right-drag", label: "Orbit" },
    { keys: "⇧-drag / middle-drag", label: "Pan" },
    { keys: "Wheel / pinch", label: "Zoom to the cursor" },
    { keys: "Click", label: "Select (⇧/⌘-click adds)" },
  ],
};

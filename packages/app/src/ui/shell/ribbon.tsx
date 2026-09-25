/**
 * The ribbon's workspaces and slots (FULL-MODELING-PLAN §2.5 "Top: toolbar tabs"; the owner's
 * "toolbar grouping like Fusion"): the title bar's **Solid** and **Sketch** tabs pick what the
 * ribbon shows.
 *
 * - **Solid:** the tool registry's groups (Sketch, Create, Pattern, Modify, Construct, Inspect, Print).
 * - **Sketch:** the sketcher's own tools. While a sketch is open the Sketch tab is forced on and the
 *   sketcher renders its palette, constraints and Finish/Cancel into the ribbon's slots through
 *   {@link RibbonPortal} (one implementation, the same test ids; outside the shell they render in
 *   place, as before). The shell's `sketch` mode (tools registered with `modes: ["sketch"]`) shows
 *   there too.
 */
import { useEffect, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sketchMode } from "../../sketch/instance";
import { Store } from "../../store";
import { useStore } from "../context";
import { useShellState } from "./context";

export type Workspace = "solid" | "sketch";

class WorkspaceStore extends Store<{ tab: Workspace }> {
  constructor() {
    super({ tab: "solid" });
  }
  set(tab: Workspace): void {
    this.setState({ tab });
  }
}

/** The tab the user picked (a sketch in progress overrides it, see {@link useWorkspace}). */
export const workspaceTab = new WorkspaceStore();

/** Whether the sketcher is open (choosing a plane, loading or drawing). */
export function useSketching(): boolean {
  return useStore(sketchMode, (s) => s.phase !== "off");
}

/** The workspace the ribbon shows now: Sketch while a sketch is open or the shell is in sketch mode, else the chosen tab. */
export function useWorkspace(): Workspace {
  const sketching = useSketching();
  const mode = useShellState((s) => s.mode);
  const chosen = useStore(workspaceTab, (s) => s.tab);
  // Closing a sketch returns to Solid (Fusion's Finish Sketch does the same).
  useEffect(() => {
    if (!sketching) workspaceTab.set("solid");
  }, [sketching]);
  return sketching || mode === "sketch" ? "sketch" : chosen;
}

type SlotName = "tools" | "actions" | "title";

class SlotStore extends Store<Record<SlotName, HTMLElement | null>> {
  constructor() {
    super({ tools: null, actions: null, title: null });
  }
  set(name: SlotName, el: HTMLElement | null): void {
    this.setState({ [name]: el } as Partial<Record<SlotName, HTMLElement | null>>);
  }
}

/** Where the sketcher's ribbon content goes (the ribbon registers its slots while the Sketch tab shows). */
export const ribbonSlots = new SlotStore();

/** A callback ref that registers a ribbon slot. */
export const slotRef =
  (name: SlotName) =>
  (el: HTMLElement | null): void =>
    ribbonSlots.set(name, el);

/** Render `children` into a ribbon slot when the ribbon has one, else in place. */
export function RibbonPortal({ slot, children }: { slot: SlotName; children: ReactNode }): ReactElement {
  const el = useStore(ribbonSlots, (s) => s[slot]);
  return el ? createPortal(children, el) : <>{children}</>;
}

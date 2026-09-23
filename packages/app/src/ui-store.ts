/**
 * Session UI state that is not part of the document (and never undoable): theme, panels,
 * dialogs, chat transcript, toasts, hover, recent files, viewport status.
 */
import type { AppInfo } from "./bridge";
import type { Projection, ViewName } from "./engine/forge-web-contract";
import type { PickResult } from "./engine/types";
import { Store } from "./store";

export type ThemePreference = "dark" | "light" | "system";
export type PanelId = "left" | "right" | "chat" | "problems";

export interface SelectionChip {
  kind: "feature" | "face" | "edge" | "body";
  /** Stable reference, e.g. a feature id or a face provenance name. */
  ref: string;
  label: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  chips: SelectionChip[];
  time: number;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
}

export type DialogId = "palette" | "templates" | "about" | null;

export interface ViewportStatus {
  kind: "placeholder" | "forge-web" | "none";
  backend: string;
  projection: Projection;
  view: ViewName | null;
}

export interface UiState {
  theme: ThemePreference;
  resolvedTheme: "dark" | "light";
  panels: Record<PanelId, boolean>;
  dialog: DialogId;
  chat: ChatMessage[];
  /** Incremented to ask the chat input to take focus. */
  chatFocusTick: number;
  toasts: Toast[];
  hover: PickResult | null;
  /** Feature whose statement holds the editor cursor. */
  codeFocusFeatureId: string | null;
  recentFiles: string[];
  viewport: ViewportStatus;
  appInfo: AppInfo | null;
}

const THEME_KEY = "aicad.theme";
const PANELS_KEY = "aicad.panels";

function readLocal(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, tests): preferences are per-session then.
  }
}

function systemTheme(): "dark" | "light" {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

const DEFAULT_PANELS: Record<PanelId, boolean> = { left: true, right: true, chat: true, problems: true };

export const WELCOME_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "system",
  text:
    "The design agent is not connected in this build. The chat UI is here so the co-editing flow can be designed: " +
    "select a feature or a face and it appears as a chip on your message. Once packages/agent is wired in, " +
    "it will edit this document through the same command layer you use.",
  chips: [],
  time: 0,
};

export class UiStore extends Store<UiState> {
  private toastSeq = 1;
  private msgSeq = 1;

  constructor() {
    const stored = readLocal(THEME_KEY);
    const theme: ThemePreference = stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
    let panels = DEFAULT_PANELS;
    try {
      const p = JSON.parse(readLocal(PANELS_KEY) ?? "null") as Partial<Record<PanelId, boolean>> | null;
      if (p && typeof p === "object") panels = { ...DEFAULT_PANELS, ...p };
    } catch {
      // ignore malformed preference
    }
    super({
      theme,
      resolvedTheme: theme === "system" ? systemTheme() : theme,
      panels,
      dialog: null,
      chat: [WELCOME_MESSAGE],
      chatFocusTick: 0,
      toasts: [],
      hover: null,
      codeFocusFeatureId: null,
      recentFiles: [],
      viewport: { kind: "none", backend: "", projection: "perspective", view: "iso" },
      appInfo: null,
    });
  }

  setTheme(theme: ThemePreference): void {
    writeLocal(THEME_KEY, theme);
    this.setState({ theme, resolvedTheme: theme === "system" ? systemTheme() : theme });
  }

  /** Re-resolve `system` after the OS theme changed. */
  refreshSystemTheme(): void {
    const s = this.getState();
    if (s.theme === "system") this.setState({ resolvedTheme: systemTheme() });
  }

  setPanel(panel: PanelId, visible: boolean): void {
    const panels = { ...this.getState().panels, [panel]: visible };
    writeLocal(PANELS_KEY, JSON.stringify(panels));
    this.setState({ panels });
  }

  openDialog(dialog: DialogId): void {
    this.setState({ dialog });
  }

  closeDialog(): void {
    this.setState({ dialog: null });
  }

  addChatMessage(role: ChatMessage["role"], text: string, chips: SelectionChip[] = []): ChatMessage {
    const msg: ChatMessage = { id: `m${this.msgSeq++}`, role, text, chips, time: Date.now() };
    this.setState((s) => ({ chat: [...s.chat, msg] }));
    return msg;
  }

  focusChat(): void {
    this.setState((s) => ({ chatFocusTick: s.chatFocusTick + 1 }));
  }

  toast(kind: Toast["kind"], message: string, ttlMs = kind === "error" ? 8000 : 4000): void {
    const id = this.toastSeq++;
    this.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
    setTimeout(() => this.dismissToast(id), ttlMs);
  }

  dismissToast(id: number): void {
    this.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }

  setHover(hover: PickResult | null): void {
    const cur = this.getState().hover;
    if (cur?.body === hover?.body && cur?.face === hover?.face && cur?.edge === hover?.edge) return;
    this.setState({ hover });
  }

  setCodeFocus(featureId: string | null): void {
    this.setState({ codeFocusFeatureId: featureId });
  }

  setRecentFiles(recentFiles: string[]): void {
    this.setState({ recentFiles });
  }

  setViewport(patch: Partial<ViewportStatus>): void {
    this.setState((s) => ({ viewport: { ...s.viewport, ...patch } }));
  }

  setAppInfo(appInfo: AppInfo): void {
    this.setState({ appInfo });
  }
}

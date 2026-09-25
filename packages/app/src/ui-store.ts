/**
 * Session UI state that is not part of the document (and never undoable): theme, panels,
 * dialogs, chat transcript, toasts, hover, recent files, viewport status.
 */
import type { AppInfo } from "./bridge";
import type { Projection, ViewName } from "./engine/forge-web-contract";
import type { PickResult } from "./engine/types";
import { Store } from "./store";

export type ThemePreference = "dark" | "light" | "system";
/** `code`: the read-only code view (View ▸ Show Code), off by default: PartZero is not a code editor. */
export type PanelId = "left" | "right" | "chat" | "problems" | "code";

export interface SelectionChip {
  kind: "feature" | "face" | "edge" | "body";
  /** Stable reference, e.g. a feature id or a face provenance name. */
  ref: string;
  label: string;
}

export interface ChatMessage {
  id: string;
  /** `agent`: a live run card (progress, questions, result) for `runId`. */
  role: "user" | "assistant" | "system" | "agent";
  text: string;
  chips: SelectionChip[];
  time: number;
  runId?: string;
  tone?: "error";
  /** A command button under the message (e.g. "Open Settings"). */
  action?: { label: string; command: string };
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
  /** One button in the toast, e.g. "Show in Finder" after an export. */
  action?: { label: string; run: () => void };
}

export type DialogId = "palette" | "templates" | "about" | "settings" | null;

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

const DEFAULT_PANELS: Record<PanelId, boolean> = { left: true, right: true, chat: true, problems: true, code: false };

export const WELCOME_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "system",
  text:
    "Describe a part or a change. The assistant builds it with the same modeling tools you use, step by step, live in the viewport and the timeline — Stop keeps what it built, and one Undo takes its whole turn back. " +
    "Select a feature or a face first and it travels with your message as context.",
  chips: [],
  time: 0,
};

export const WELCOME_MESSAGE_WEB: ChatMessage = {
  ...WELCOME_MESSAGE,
  text: "The design agent runs in the desktop app, on your Claude Code plan. The chat is shown here so the co-editing flow can be tried.",
};

export class UiStore extends Store<UiState> {
  private toastSeq = 1;
  private msgSeq = 1;

  constructor(options: { agentAvailable?: boolean } = {}) {
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
      chat: [options.agentAvailable === false ? WELCOME_MESSAGE_WEB : WELCOME_MESSAGE],
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

  addChatMessage(
    role: ChatMessage["role"],
    text: string,
    chips: SelectionChip[] = [],
    extra: { runId?: string; tone?: "error"; action?: { label: string; command: string } } = {},
  ): ChatMessage {
    const msg: ChatMessage = { id: `m${this.msgSeq++}`, role, text, chips, time: Date.now(), ...extra };
    this.setState((s) => ({ chat: [...s.chat, msg] }));
    return msg;
  }

  focusChat(): void {
    this.setState((s) => ({ chatFocusTick: s.chatFocusTick + 1 }));
  }

  toast(kind: Toast["kind"], message: string, ttlMs = kind === "error" ? 8000 : 4000, action?: Toast["action"]): void {
    const id = this.toastSeq++;
    this.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message, ...(action ? { action } : {}) }] }));
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

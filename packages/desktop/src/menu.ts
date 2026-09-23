/**
 * The native menu. Every item sends a command-layer invocation to the renderer (`menu:command`),
 * so menu, keyboard, palette and agent all run the same commands. Accelerators are displayed but
 * not registered (`registerAccelerator: false`): the renderer's keyboard handler owns shortcuts,
 * which keeps one owner per key. Clipboard items stay native roles (macOS needs them).
 */
import type { MenuItemConstructorOptions } from "electron";
import type { MenuCommandMessage } from "@aicad/app/bridge";

export interface MenuDeps {
  send: (message: MenuCommandMessage) => void;
  recentFiles: readonly string[];
  platform: NodeJS.Platform;
  appName: string;
  /** Unpackaged run: adds Reload and Toggle Developer Tools (a packaged build has neither). */
  isDev: boolean;
}

function baseName(p: string): string {
  return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}

export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const isMac = deps.platform === "darwin";
  const cmd = (
    label: string,
    id: string,
    args?: unknown,
    accelerator?: string,
    extra: Partial<MenuItemConstructorOptions> = {},
  ): MenuItemConstructorOptions => ({
    id: args === undefined ? id : `${id}:${JSON.stringify(args)}`,
    label,
    click: () => deps.send(args === undefined ? { id } : { id, args }),
    ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
    ...extra,
  });
  const sep: MenuItemConstructorOptions = { type: "separator" };

  const recent: MenuItemConstructorOptions[] =
    deps.recentFiles.length > 0
      ? [
          ...deps.recentFiles.map((p) => cmd(baseName(p), "file.openRecent", { path: p }, undefined, { toolTip: p, sublabel: p })),
          sep,
          cmd("Clear Recent", "file.clearRecent"),
        ]
      : [{ label: "No Recent Files", enabled: false }];

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: deps.appName,
          submenu: [
            cmd(`About ${deps.appName}`, "help.about"),
            sep,
            cmd("Settings…", "settings.open", undefined, "CmdOrCtrl+,"),
            sep,
            { role: "services" },
            sep,
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            sep,
            { role: "quit" },
          ],
        },
      ]
    : [];

  return [
    ...appMenu,
    {
      label: "&File",
      submenu: [
        cmd("New", "file.new", undefined, "CmdOrCtrl+N"),
        cmd("New from Template…", "file.newFromTemplate", undefined, "CmdOrCtrl+Shift+N"),
        sep,
        cmd("Open…", "file.open", undefined, "CmdOrCtrl+O"),
        { label: "Open Recent", submenu: recent },
        sep,
        cmd("Save", "file.save", undefined, "CmdOrCtrl+S"),
        cmd("Save As…", "file.saveAs", undefined, "CmdOrCtrl+Shift+S"),
        sep,
        ...(isMac ? [] : [cmd("Settings…", "settings.open", undefined, "CmdOrCtrl+,"), sep]),
        {
          label: "Export",
          submenu: [
            cmd("3MF…", "file.exportMesh", { format: "3mf" }, "CmdOrCtrl+E"),
            cmd("STL…", "file.exportMesh", { format: "stl" }),
            cmd("OBJ…", "file.exportMesh", { format: "obj" }),
          ],
        },
        sep,
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        cmd("Undo", "edit.undo", undefined, "CmdOrCtrl+Z"),
        cmd("Redo", "edit.redo", undefined, "CmdOrCtrl+Shift+Z"),
        sep,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        sep,
        cmd("Command Palette…", "view.commandPalette", undefined, "CmdOrCtrl+K"),
      ],
    },
    {
      label: "&Agent",
      submenu: [
        cmd("Ask the Agent…", "chat.focus", undefined, "CmdOrCtrl+L"),
        cmd("Stop", "agent.stop", undefined, "CmdOrCtrl+."),
        sep,
        cmd("Accept Proposal", "agent.accept"),
        cmd("Reject Proposal", "agent.reject"),
        sep,
        cmd("Settings…", "settings.open"),
      ],
    },
    {
      label: "&View",
      submenu: [
        cmd("Zoom to Fit", "view.fit", undefined, "F"),
        {
          label: "Standard Views",
          submenu: [
            cmd("Isometric", "view.setView", { view: "iso" }),
            cmd("Top", "view.setView", { view: "top" }),
            cmd("Front", "view.setView", { view: "front" }),
            cmd("Right", "view.setView", { view: "right" }),
          ],
        },
        {
          label: "Projection",
          submenu: [
            cmd("Perspective", "view.setProjection", { projection: "perspective" }),
            cmd("Orthographic", "view.setProjection", { projection: "orthographic" }),
          ],
        },
        sep,
        cmd("Toggle Timeline", "view.toggleTimeline", undefined, "CmdOrCtrl+B"),
        cmd("Toggle Code & Chat", "view.togglePanel", { panel: "right" }),
        cmd("Toggle Problems", "view.toggleProblems", undefined, "CmdOrCtrl+J"),
        cmd("Toggle Light/Dark Theme", "view.toggleTheme", undefined, "CmdOrCtrl+Shift+L"),
        sep,
        cmd("Recompute", "doc.recompute", undefined, "F5"),
        sep,
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        sep,
        { role: "togglefullscreen" },
        ...(deps.isDev ? [sep, { role: "reload" } as MenuItemConstructorOptions, { role: "toggleDevTools" } as MenuItemConstructorOptions] : []),
      ],
    },
    {
      role: "window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [sep, { role: "front" } as MenuItemConstructorOptions] : [])],
    },
    {
      role: "help",
      submenu: [cmd("Command Palette…", "view.commandPalette"), ...(isMac ? [] : [sep, cmd(`About ${deps.appName}`, "help.about")])],
    },
  ];
}

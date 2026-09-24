/**
 * The file IPC handlers of ipc.ts, driven directly (Electron's `ipcMain` and `dialog` replaced by a
 * recorder): what the renderer can read and write after Open Recent and Clear Recent (phase 0 audit
 * L14), and the printing channels (ALPHA-0-PLAN W5).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSetup } from "../src/agent/setup.js";
import { canonicalPath, PathGrants, RecentFiles } from "../src/files.js";
import { ProfileStore } from "../src/profiles.js";
import { defaultSlicerSystem } from "../src/slicer.js";
import { tempDirs } from "./temp-dirs.js";

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => ipc.handlers.set(channel, fn),
    on: () => undefined,
  },
  dialog: {},
}));

const { registerIpc } = await import("../src/ipc.js");

const tmp = tempDirs("aicad-ipc-test-");
const fromApp = { senderFrame: { url: "app://aicad/index.html" } };

/** Invoke a channel as the app's renderer would. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipc.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(fromApp, ...args);
}

/** A session started with `recentList` persisted: grants restored exactly as main.ts does. */
function startSession(recentList: string): { grants: PathGrants; recent: RecentFiles } {
  ipc.handlers.clear();
  const grants = new PathGrants();
  const recent = new RecentFiles(recentList);
  for (const e of recent.entries()) grants.grantRecent(e.path, e.real);
  registerIpc({
    agent: { host: {}, keys: {}, settings: {} } as unknown as AgentSetup,
    window: () => null,
    isTrustedSender: (url) => url === fromApp.senderFrame.url,
    grants,
    recent,
    forgeBin: "/nonexistent/aicad",
    appInfo: () => Promise.reject(new Error("unused")),
    onRecentChanged: () => undefined,
    onDocState: () => undefined,
  });
  return { grants, recent };
}

describe("L14: Clear Recent and the open document", () => {
  let dir: string;
  let listFile: string;
  let opened: string;
  let neverOpened: string;

  beforeEach(() => {
    dir = tmp();
    listFile = join(dir, "recent-files.json");
    opened = join(dir, "opened.cad.ts");
    neverOpened = join(dir, "never-opened.cad.ts");
    writeFileSync(opened, "export default 1;");
    writeFileSync(neverOpened, "export default 2;");
    const earlier = new RecentFiles(listFile);
    for (const p of [neverOpened, opened]) earlier.add(p, canonicalPath(p));
  });

  it("Save keeps working for a document opened through Open Recent after Clear Recent", async () => {
    startSession(listFile);
    expect(await invoke("fs:readText", opened)).toBe("export default 1;"); // Open Recent
    await invoke("recent:clear");
    expect(await invoke("recent:list")).toEqual([]);
    await invoke("fs:write", opened, "export default 42;"); // Cmd+S
    expect(readFileSync(opened, "utf8")).toBe("export default 42;");
    // The documents that were only in the list are forgotten.
    await expect(invoke("fs:readText", neverOpened)).rejects.toThrow(/access denied/);
    await expect(invoke("fs:write", neverOpened, "x")).rejects.toThrow(/access denied/);
    expect(readFileSync(neverOpened, "utf8")).toBe("export default 2;");
  });

  it("records the canonical path with each recent document", async () => {
    startSession(listFile);
    await invoke("fs:readText", opened);
    expect(new RecentFiles(listFile).entries()[0]).toEqual({ path: opened, real: canonicalPath(opened) });
  });
});

describe("printing channels", () => {
  it("serve the profile, validate the slicer path and show only files in the prints folder", async () => {
    const dir = tmp();
    const printsDir = join(dir, "Prints");
    mkdirSync(printsDir);
    const inside = join(printsDir, "knob-1a2b3c4d.3mf");
    writeFileSync(inside, "PK");
    const outside = join(dir, "elsewhere.3mf");
    writeFileSync(outside, "PK");
    const revealed: string[] = [];
    ipc.handlers.clear();
    registerIpc({
      agent: { host: {}, keys: {}, settings: {} } as unknown as AgentSetup,
      window: () => null,
      isTrustedSender: (url) => url === fromApp.senderFrame.url,
      grants: new PathGrants(),
      recent: new RecentFiles(join(dir, "recent.json")),
      forgeBin: "/nonexistent/aicad",
      appInfo: () => Promise.reject(new Error("unused")),
      onRecentChanged: () => undefined,
      onDocState: () => undefined,
      print: {
        forgeBin: "/nonexistent/aicad",
        printsDir,
        appVersion: "0.0.1",
        profiles: new ProfileStore(join(dir, "machine-profiles.json")),
        slicer: { ...defaultSlicerSystem({ searchDirs: [] }), platform: "darwin" },
        revealInFolder: (p) => revealed.push(p),
      },
    });
    expect(await invoke("print:profile")).toMatchObject({ summary: "Bambu Lab P2S · 0.4 mm · PLA", printsDir, printer: { bed: { x: 256, y: 256, z: 256 } } });
    // A wrong path set in Settings is reported as not found; a malformed one is refused.
    const missing = join(dir, "Nowhere", "BambuStudio.app");
    expect(await invoke("slicer:setPath", missing)).toMatchObject({ found: false, customPath: missing });
    await expect(invoke("slicer:setPath", "relative/BambuStudio.app")).rejects.toThrow(/absolute/);
    expect(await invoke("slicer:setPath", null)).toMatchObject({ found: false, customPath: null });
    // Show in Finder: the prints folder only.
    await invoke("print:reveal", inside);
    await expect(invoke("print:reveal", outside)).rejects.toThrow(/only files in/);
    expect(revealed).toEqual([inside]);
    // The handoff validates its request and reports a missing Forge CLI.
    await expect(invoke("slicer:open", { irJson: 42, docName: "x" })).rejects.toThrow(/invalid IR/);
    expect(await invoke("slicer:open", { irJson: "{}", docName: "x" })).toMatchObject({ status: "refused", code: "FORGE_UNAVAILABLE" });
    // An untrusted frame gets nothing.
    expect(() => ipc.handlers.get("print:profile")!({ senderFrame: { url: "https://evil.example/" } })).toThrow(/untrusted/);
  });
});

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDocumentPath, PathGrants, RecentFiles } from "../src/files.js";
import { findRepoRoot, forgeEval, forgeExport, forgeInfo, locateForgeBinary } from "../src/forge-cli.js";
import { buildMenuTemplate } from "../src/menu.js";
import { contentTypeFor, resolveAssetPath, SECURITY_HEADERS } from "../src/protocol-core.js";
import { sanitizeWindowState } from "../src/window-state.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "aicad-desktop-test-"));

describe("app:// protocol", () => {
  const root = resolve("/srv/web");

  it("maps URLs into the web root", () => {
    expect(resolveAssetPath(root, "app://aicad/index.html")).toBe(join(root, "index.html"));
    expect(resolveAssetPath(root, "app://aicad/")).toBe(join(root, "index.html"));
    expect(resolveAssetPath(root, "app://aicad/assets/a%20b.js?v=1#x")).toBe(join(root, "assets", "a b.js"));
  });

  it("refuses traversal, other hosts and other schemes", () => {
    expect(resolveAssetPath(root, "app://aicad/../etc/passwd")).toBe(join(root, "etc", "passwd")); // URL parser collapses `..`
    expect(resolveAssetPath(root, "app://aicad/%2e%2e/%2e%2e/etc/passwd")).not.toMatch(/^\/etc/);
    expect(resolveAssetPath(root, "app://aicad/..%2f..%2fetc%2fpasswd")).toBeNull();
    expect(resolveAssetPath(root, "app://aicad/a%5c..%5c..%5cx")).toBeNull();
    expect(resolveAssetPath(root, "app://evil/index.html")).toBeNull();
    expect(resolveAssetPath(root, "file:///etc/passwd")).toBeNull();
    expect(resolveAssetPath(root, "not a url")).toBeNull();
  });

  it("sends cross-origin isolation headers and a strict CSP", () => {
    expect(SECURITY_HEADERS["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(SECURITY_HEADERS["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toMatch(/ 'unsafe-eval'/);
    expect(contentTypeFor("x.wasm")).toBe("application/wasm");
    expect(contentTypeFor("x.JS")).toMatch(/^text\/javascript/);
    expect(contentTypeFor("x.unknown")).toBe("application/octet-stream");
  });
});

describe("window state", () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };

  it("keeps valid bounds and clamps sizes", () => {
    expect(sanitizeWindowState({ x: 100, y: 80, width: 1200, height: 800, maximized: true }, [display])).toEqual({
      x: 100,
      y: 80,
      width: 1200,
      height: 800,
      maximized: true,
    });
    expect(sanitizeWindowState({ width: 10, height: 99999 }, [display])).toMatchObject({ width: 900, height: 1080 });
  });

  it("drops positions that are off every display, and survives garbage", () => {
    expect(sanitizeWindowState({ x: 5000, y: 5000, width: 1200, height: 800 }, [display])).not.toHaveProperty("x");
    expect(sanitizeWindowState({ x: -1150, y: 10, width: 1200, height: 800 }, [display])).not.toHaveProperty("x");
    expect(sanitizeWindowState("nope", [display])).toEqual({ width: 1440, height: 900, maximized: false });
    expect(sanitizeWindowState({ x: Number.NaN, y: 0, width: "big" }, [])).toEqual({ width: 1440, height: 900, maximized: false });
  });
});

describe("file access", () => {
  it("grants only paths chosen in dialogs", () => {
    const g = new PathGrants();
    expect(() => g.check("/tmp/a.cad.ts")).toThrow(/access denied/);
    g.grant("/tmp/x/../a.cad.ts");
    expect(g.check("/tmp/a.cad.ts")).toBe(resolve("/tmp/a.cad.ts"));
    expect(() => g.check(42)).toThrow(/invalid path/);
    expect(() => g.check("/tmp/a\0.cad.ts")).toThrow(/invalid path/);
    expect(isDocumentPath("/a/b.cad.ts")).toBe(true);
    expect(isDocumentPath("/a/b.json")).toBe(true);
    expect(isDocumentPath("/a/b.3mf")).toBe(false);
  });

  it("persists recent files, most recent first, deduplicated and capped", () => {
    const file = join(tmp(), "recent.json");
    const r = new RecentFiles(file, 3);
    for (const p of ["/a.cad.ts", "/b.cad.ts", "/a.cad.ts", "/c.json", "/d.json"]) r.add(p);
    expect(r.list()).toEqual(["/d.json", "/c.json", "/a.cad.ts"].map((p) => resolve(p)));
    expect(new RecentFiles(file, 3).list()).toEqual(r.list());
    r.clear();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
    writeFileSync(file, "{broken");
    expect(new RecentFiles(file).list()).toEqual([]);
  });
});

describe("native menu", () => {
  it("routes every custom item to a command and never registers accelerators", () => {
    const sent: unknown[] = [];
    const template = buildMenuTemplate({ send: (m) => sent.push(m), recentFiles: ["/w/a.cad.ts"], platform: "darwin", appName: "aicad", isDev: false });
    const items: Array<Record<string, unknown>> = [];
    const walk = (list: unknown): void => {
      if (!Array.isArray(list)) return;
      for (const it of list as Array<Record<string, unknown>>) {
        items.push(it);
        walk(it["submenu"]);
      }
    };
    walk(template);
    const withAccel = items.filter((i) => i["accelerator"]);
    expect(withAccel.length).toBeGreaterThan(8);
    for (const i of withAccel) expect(i["registerAccelerator"]).toBe(false);
    const exp = items.find((i) => i["id"] === 'file.exportMesh:{"format":"3mf"}')!;
    (exp["click"] as () => void)();
    const recent = items.find((i) => i["label"] === "a.cad.ts")!;
    (recent["click"] as () => void)();
    expect(sent).toEqual([
      { id: "file.exportMesh", args: { format: "3mf" } },
      { id: "file.openRecent", args: { path: "/w/a.cad.ts" } },
    ]);
    // Clipboard stays native.
    expect(items.some((i) => i["role"] === "paste")).toBe(true);
  });
});

const repo = findRepoRoot(fileURLToPath(new URL(".", import.meta.url)));
const bin = locateForgeBinary({ env: {}, isPackaged: false, resourcesPath: "", appPath: fileURLToPath(new URL("..", import.meta.url)) });

describe("Forge CLI bridge", () => {
  it("locates the binary: $AICAD_BIN, packaged resources, then the repo build", () => {
    expect(repo).not.toBeNull();
    expect(locateForgeBinary({ env: { AICAD_BIN: "/opt/aicad" }, isPackaged: false, resourcesPath: "", appPath: "/" })).toBe(resolve("/opt/aicad"));
    expect(locateForgeBinary({ env: {}, isPackaged: true, resourcesPath: "/App/Resources", appPath: "/" })).toBe(join("/App/Resources", "bin", process.platform === "win32" ? "aicad.exe" : "aicad"));
    expect(bin.startsWith(join(repo!, "forge", "target"))).toBe(true);
  });

  it("reports a missing binary with a fix", async () => {
    const info = await forgeInfo("/nonexistent/aicad");
    expect(info.available).toBe(false);
    expect(info.detail).toMatch(/cargo build -p forge-cli/);
  });

  const irJson = existsSync(join(repo ?? "", "corpus", "programs", "extrude_box.json"))
    ? readFileSync(join(repo!, "corpus", "programs", "extrude_box.json"), "utf8")
    : null;

  it.skipIf(!existsSync(bin) || !irJson)("evaluates and exports through the real aicad binary", async () => {
    const ev = await forgeEval(bin, { irJson: irJson! });
    expect(ev.error).toBeUndefined();
    expect(ev.evalExitCode).toBe(0);
    expect(JSON.parse(ev.reportJson!).schema).toBe("aicad.metrics/0");
    expect(ev.objText).toMatch(/^o /m);
    expect(ev.objText).toMatch(/^g \w+\/cap:end$/m);
    const ex = await forgeExport(bin, { irJson: irJson!, format: "3mf" });
    expect(ex.exitCode).toBe(0);
    expect(Buffer.from(ex.data!.subarray(0, 2)).toString()).toBe("PK");
    await expect(forgeExport(bin, { irJson: irJson!, format: "step" as never })).rejects.toThrow(/unsupported/);
  });
});

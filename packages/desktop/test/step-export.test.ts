/**
 * STEP export in the main process (src/step-export.ts): request validation, and the real
 * `aicad export --format step` on corpus programs when the debug binary is built.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentSetup } from "../src/agent/setup.js";
import { PathGrants, RecentFiles } from "../src/files.js";
import { forgeStepExport, handleStepExport, validateStepRequest } from "../src/step-export.js";

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => ipc.handlers.set(channel, fn),
    on: () => undefined,
  },
  dialog: {},
}));
const { registerIpc } = await import("../src/ipc.js");

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const aicad = join(repo, "forge", "target", "debug", "aicad");
const haveAicad = existsSync(aicad);
const program = (name: string): string => readFileSync(join(repo, "corpus", "programs", name), "utf8");

describe("validateStepRequest", () => {
  it("fills the defaults and sanitizes the product name", () => {
    expect(validateStepRequest({ irJson: "{}" })).toEqual({
      irJson: "{}",
      schema: "ap214",
      productName: "part",
      allowPartial: false,
    });
    expect(validateStepRequest({ irJson: "{}", schema: "ap242", productName: "a\u0007b\n", allowPartial: true })).toEqual({
      irJson: "{}",
      schema: "ap242",
      productName: "a b",
      allowPartial: true,
    });
  });

  it("rejects malformed requests from the renderer", () => {
    expect(() => validateStepRequest(null)).toThrow("invalid IR");
    expect(() => validateStepRequest({ irJson: "" })).toThrow("invalid IR");
    expect(() => validateStepRequest({ irJson: "{}", schema: "ap203" })).toThrow("invalid STEP schema");
    expect(() => validateStepRequest({ irJson: "{}", productName: 7 })).toThrow("invalid product name");
  });
});

describe("the forge:exportStep channel", () => {
  it("is registered for the app's renderer and validates its request", async () => {
    ipc.handlers.clear();
    registerIpc({
      agent: { host: {}, keys: {}, settings: {} } as unknown as AgentSetup,
      window: () => null,
      isTrustedSender: (url) => url === "app://aicad/index.html",
      grants: new PathGrants(),
      recent: new RecentFiles(join(repo, "nonexistent-recent.json")),
      forgeBin: "/nonexistent/aicad",
      appInfo: () => Promise.reject(new Error("unused")),
      onRecentChanged: () => undefined,
      onDocState: () => undefined,
    });
    const handler = ipc.handlers.get("forge:exportStep");
    expect(handler).toBeDefined();
    const fromApp = { senderFrame: { url: "app://aicad/index.html" } };
    await expect(Promise.resolve(handler?.(fromApp, { irJson: "{}", schema: "x" }))).rejects.toThrow(
      "invalid STEP schema",
    );
    const r = (await handler?.(fromApp, { irJson: "{}" })) as { data: unknown; error?: string };
    expect(r.data).toBeNull();
    expect(r.error).toMatch(/not found/);
  });
});

describe("handleStepExport", () => {
  it("reports a missing binary instead of throwing", async () => {
    const r = await handleStepExport("/nonexistent/aicad", { irJson: program("extrude_box.json") });
    expect(r.data).toBeNull();
    expect(r.error).toMatch(/not found/);
  });
});

describe.skipIf(!haveAicad)("aicad export --format step (forge/target/debug/aicad)", () => {
  it("writes a STEP file and the summary for a v0 program", async () => {
    const r = await forgeStepExport(aicad, validateStepRequest({ irJson: program("revolve_torus.json"), productName: "torus" }));
    expect(r.exitCode, r.stderr).toBe(0);
    const text = new TextDecoder().decode(r.data ?? new Uint8Array());
    expect(text.startsWith("ISO-10303-21;")).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN");
    expect(text).toContain("PRODUCT('torus','torus'");
    expect(text).toContain("TOROIDAL_SURFACE");
    const summary = r.summary as { format: string; bodies: Array<{ step: { seamEdges: number } }> };
    expect(summary.format).toBe("step");
    expect(summary.bodies[0]?.step.seamEdges).toBe(2); // a whole torus: two seam circles
  });

  it("is deterministic and honours AP242", async () => {
    const req = validateStepRequest({ irJson: program("extrude_plate_with_holes.json"), schema: "ap242" });
    const a = await forgeStepExport(aicad, req);
    const b = await forgeStepExport(aicad, req);
    expect(a.exitCode).toBe(0);
    expect(Buffer.from(a.data ?? [])).toEqual(Buffer.from(b.data ?? []));
    expect(new TextDecoder().decode(a.data ?? new Uint8Array())).toContain("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING");
  });

  it("fails without bytes on a rejected document", async () => {
    const r = await forgeStepExport(aicad, validateStepRequest({ irJson: '{"schema":"aicad.ir/1","parts":"nope"}' }));
    expect(r.exitCode).not.toBe(0);
    expect(r.data).toBeNull();
  });
});

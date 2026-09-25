/**
 * The `file.exportStep` command (src/io/step-export-command.ts), run through a real command
 * registry the way the menu, palette, agent and MCP will run it once it is registered.
 */
import { describe, expect, it } from "vitest";
import type { AicadBridge, ForgeStepExportRequest, ForgeStepExportResponse, SaveDialogOptions } from "../src/bridge";
import { CommandRegistry } from "../src/commands/registry";
import { EXPORT_STEP_COMMAND, makeExportStepCommand, stepFailureMessage } from "../src/io/step-export-command";
import { StepExportError } from "../src/io/step-export";

const STEP_BYTES = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");
const V1_DOC = JSON.stringify({ schema: "aicad.ir/1", parts: [] });

const BODY = {
  name: "plate/plate",
  forge: { volume: 1200, area: 1040, faces: 6, edges: 12, vertices: 8 },
  step: { solids: 1, voids: 0, faces: 6, edges: 12, vertices: 8, seamEdges: 0, splitPieces: 0, newVertices: 0 },
};

const OK: ForgeStepExportResponse = {
  data: STEP_BYTES,
  summary: { schema: "aicad.export/1", format: "step", error: null, bodies: [BODY, { ...BODY, name: "plate/boss" }] },
  exitCode: 0,
  stderr: "aicad: wrote …",
};

interface Ctx {
  compiles: boolean;
  exportStep: ((r: ForgeStepExportRequest) => Promise<ForgeStepExportResponse>) | null;
  pick: string | null;
  dialogs: SaveDialogOptions[];
  requests: ForgeStepExportRequest[];
  writes: Array<[string, string | Uint8Array]>;
  toasts: Array<[string, string]>;
}

function setup(over: Partial<Ctx> = {}) {
  const ctx: Ctx = {
    compiles: true,
    exportStep: () => Promise.resolve(OK),
    pick: "/tmp/out/bracket.step",
    dialogs: [],
    requests: [],
    writes: [],
    toasts: [],
    ...over,
  };
  const spec = makeExportStepCommand<Ctx>({
    document: (c, action) =>
      c.compiles
        ? Promise.resolve({ irJson: V1_DOC, name: "bracket" })
        : Promise.reject(new Error(`Cannot ${action}: the code has 1 error. Fix them first.`)),
    host: (c) => ({
      forgeCli: {
        info: () => Promise.reject(new Error("unused")),
        eval: () => Promise.reject(new Error("unused")),
        export: () => Promise.reject(new Error("unused")),
        ...(c.exportStep
          ? {
              exportStep: (r: ForgeStepExportRequest) => {
                c.requests.push(r);
                return c.exportStep!(r);
              },
            }
          : {}),
      } as AicadBridge["forge"],
      pickSavePath: (o) => {
        c.dialogs.push(o);
        return Promise.resolve(c.pick);
      },
      writeFile: (p, d) => {
        c.writes.push([p, d]);
        return Promise.resolve();
      },
    }),
    toast: (c, kind, message) => c.toasts.push([kind, message]),
  });
  const registry = new CommandRegistry({ [EXPORT_STEP_COMMAND]: spec }, () => ctx);
  return { ctx, registry };
}

describe("file.exportStep", () => {
  it("asks where to save, exports the document as AP214 and says what it wrote", async () => {
    const { ctx, registry } = setup();
    const r = await registry.executeUnknown({ id: "file.exportStep" }, { source: "menu" });
    expect(r).toEqual({
      ok: true,
      value: { exported: true, path: "/tmp/out/bracket.step", bytes: STEP_BYTES.length, schema: "ap214", bodies: 2 },
    });
    expect(ctx.dialogs[0]).toMatchObject({ title: "Export STEP", defaultPath: "bracket.step" });
    expect(ctx.requests).toEqual([{ irJson: V1_DOC, schema: "ap214", productName: "bracket", allowPartial: false }]);
    expect(ctx.writes).toEqual([["/tmp/out/bracket.step", STEP_BYTES]]);
    expect(ctx.toasts).toEqual([["success", `Exported bracket.step (2 bodies, ${STEP_BYTES.length} B, AP214)`]]);
  });

  it("writes to a given path without a dialog, in AP242 when asked", async () => {
    const { ctx, registry } = setup();
    const r = await registry.executeUnknown(
      { id: "file.exportStep", args: { path: "/tmp/x.stp", schema: "ap242", allowPartial: true } },
      { source: "agent" },
    );
    expect(r.ok).toBe(true);
    expect(ctx.dialogs).toHaveLength(0);
    expect(ctx.requests[0]).toMatchObject({ schema: "ap242", allowPartial: true });
    expect(ctx.writes[0]?.[0]).toBe("/tmp/x.stp");
  });

  it("does nothing when the save dialog is cancelled", async () => {
    const { ctx, registry } = setup({ pick: null });
    const r = await registry.executeUnknown({ id: "file.exportStep" }, { source: "palette" });
    expect(r).toEqual({ ok: true, value: { exported: false } });
    expect(ctx.requests).toHaveLength(0);
    expect(ctx.toasts).toHaveLength(0);
  });

  it("reports a writer refusal with its code, to the user and to the caller", async () => {
    const refused: ForgeStepExportResponse = {
      data: null,
      summary: {
        schema: "aicad.export/1",
        format: "step",
        bodies: [],
        error: { code: "STEP_UNSUPPORTED_SEAM", message: "a horn-torus face needs a seam" },
      },
      exitCode: 1,
      stderr: "",
    };
    const { ctx, registry } = setup({ exportStep: () => Promise.resolve(refused) });
    const r = await registry.executeUnknown({ id: "file.exportStep" }, { source: "menu" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("FAILED");
    expect(r.error.message).toContain("STEP_UNSUPPORTED_SEAM");
    expect(ctx.writes).toHaveLength(0);
    expect(ctx.toasts).toEqual([["error", "STEP export failed: a horn-torus face needs a seam (STEP_UNSUPPORTED_SEAM)"]]);
  });

  it("refuses a document that does not compile before asking for a path", async () => {
    const { ctx, registry } = setup({ compiles: false });
    const r = await registry.executeUnknown({ id: "file.exportStep" }, { source: "menu" });
    expect(r.ok).toBe(false);
    expect(ctx.dialogs).toHaveLength(0);
    expect(ctx.toasts[0]?.[1]).toBe("STEP export failed: Cannot export STEP: the code has 1 error. Fix them first.");
  });

  it("is disabled without a Forge CLI that can export STEP (the browser build)", async () => {
    const { registry } = setup({ exportStep: null });
    expect(registry.isEnabled("file.exportStep")).toBe(false);
    const r = await registry.executeUnknown({ id: "file.exportStep" }, { source: "menu" });
    expect(r.ok ? null : r.error.code).toBe("DISABLED");
  });

  it("validates its arguments and lists two palette entries", async () => {
    const { registry } = setup();
    const bad = await registry.executeUnknown({ id: "file.exportStep", args: { schema: "ap203" } }, { source: "mcp" });
    expect(bad.ok ? null : bad.error.code).toBe("INVALID_ARGS");
    expect(registry.paletteItems().map((p) => p.title)).toEqual(["Export STEP…", "Export STEP (AP242)…"]);
    const info = registry.describe()[0];
    expect(info?.category).toBe("File");
  });

  it("formats failures that are not StepExportErrors too", () => {
    expect(stepFailureMessage(new StepExportError("FORGE_OUTDATED", "rebuild aicad"))).toBe(
      "STEP export failed: rebuild aicad (FORGE_OUTDATED)",
    );
    expect(stepFailureMessage("boom")).toBe("STEP export failed: boom");
  });
});

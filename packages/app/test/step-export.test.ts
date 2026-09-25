/**
 * The STEP export hook (src/io/step-export.ts): save dialog, the host's `forge.exportStep`, the
 * write, and coded failures.
 */
import { describe, expect, it } from "vitest";
import type { AicadBridge, ForgeStepExportRequest, ForgeStepExportResponse, SaveDialogOptions } from "../src/bridge";
import {
  classifyFailure,
  exportStepFile,
  STEP_FILE_FILTER,
  StepExportError,
  stepExportAvailable,
  stepExportFormat,
  stepFileName,
} from "../src/io/step-export";

const STEP_BYTES = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");

const SUMMARY = {
  schema: "aicad.export/1",
  format: "step",
  error: null,
  bodies: [
    {
      name: "plate/plate",
      forge: { volume: 1200, area: 1040, faces: 6, edges: 12, vertices: 8 },
      step: { solids: 1, voids: 0, faces: 6, edges: 12, vertices: 8, seamEdges: 0, splitPieces: 0, newVertices: 0 },
    },
  ],
};

interface Recorder {
  dialogs: SaveDialogOptions[];
  writes: Array<[string, string | Uint8Array]>;
  requests: ForgeStepExportRequest[];
}

function host(
  response: ForgeStepExportResponse | null,
  pick: string | null = "/tmp/out/plate.step",
): { host: Parameters<typeof exportStepFile>[0]; rec: Recorder } {
  const rec: Recorder = { dialogs: [], writes: [], requests: [] };
  const forge = {
    info: () => Promise.reject(new Error("unused")),
    eval: () => Promise.reject(new Error("unused")),
    export: () => Promise.reject(new Error("unused")),
    ...(response
      ? {
          exportStep: (r: ForgeStepExportRequest) => {
            rec.requests.push(r);
            return Promise.resolve(response);
          },
        }
      : {}),
  } as AicadBridge["forge"];
  return {
    rec,
    host: {
      forgeCli: forge,
      pickSavePath: (o) => {
        rec.dialogs.push(o);
        return Promise.resolve(pick);
      },
      writeFile: (p, d) => {
        rec.writes.push([p, d]);
        return Promise.resolve();
      },
    },
  };
}

const ok: ForgeStepExportResponse = { data: STEP_BYTES, summary: SUMMARY, exitCode: 0, stderr: "aicad: wrote …" };

describe("exportStepFile", () => {
  it("asks where to save, exports with the document name as product, and writes the bytes", async () => {
    const { host: h, rec } = host(ok);
    const r = await exportStepFile(h, { irJson: "{}", docName: "plate" });
    expect(r).toMatchObject({ exported: true, path: "/tmp/out/plate.step", bytes: STEP_BYTES.length, schema: "ap214" });
    if (!r.exported) throw new Error("unreachable");
    expect(r.bodies[0]?.step?.faces).toBe(6);
    expect(rec.dialogs[0]).toEqual({ title: "Export STEP", defaultPath: "plate.step", filters: [STEP_FILE_FILTER] });
    expect(rec.requests[0]).toEqual({ irJson: "{}", schema: "ap214", productName: "plate", allowPartial: false });
    expect(rec.writes).toEqual([["/tmp/out/plate.step", STEP_BYTES]]);
  });

  it("uses a given path and schema without a dialog", async () => {
    const { host: h, rec } = host(ok);
    const r = await exportStepFile(h, { irJson: "{}", docName: "p", path: "/x/p.stp", schema: "ap242", allowPartial: true });
    expect(r.exported).toBe(true);
    expect(rec.dialogs).toHaveLength(0);
    expect(rec.requests[0]).toMatchObject({ schema: "ap242", allowPartial: true });
  });

  it("does nothing when the dialog is cancelled", async () => {
    const { host: h, rec } = host(ok, null);
    expect(await exportStepFile(h, { irJson: "{}", docName: "p" })).toEqual({ exported: false });
    expect(rec.requests).toHaveLength(0);
    expect(rec.writes).toHaveLength(0);
  });

  it("refuses with STEP_UNAVAILABLE when the host has no STEP channel", async () => {
    const { host: h } = host(null);
    expect(stepExportAvailable(h)).toBe(false);
    await expect(exportStepFile(h, { irJson: "{}", docName: "p" })).rejects.toMatchObject({ code: "STEP_UNAVAILABLE" });
    expect(stepExportAvailable({ forgeCli: null })).toBe(false);
  });

  it("never writes a file when the export fails", async () => {
    const failed: ForgeStepExportResponse = {
      data: null,
      summary: { error: { code: "STEP_UNSUPPORTED_SEAM", message: "body \"b\", face f: no seam position avoids the face's holes" } },
      exitCode: 3,
      stderr: "aicad: STEP_UNSUPPORTED_SEAM: …",
    };
    const { host: h, rec } = host(failed);
    const e = await exportStepFile(h, { irJson: "{}", docName: "p" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StepExportError);
    expect((e as StepExportError).code).toBe("STEP_UNSUPPORTED_SEAM");
    expect(rec.writes).toHaveLength(0);
  });
});

describe("classifyFailure", () => {
  const base = { data: null, summary: null, stderr: "" };
  it("reads the writer's code from stderr when there is no summary", () => {
    const e = classifyFailure({ ...base, exitCode: 3, stderr: "aicad: STEP_SELF_CHECK: STEP check failed: #9: …" });
    expect(e.code).toBe("STEP_SELF_CHECK");
  });
  it("recognises an aicad older than STEP export", () => {
    const e = classifyFailure({ ...base, exitCode: 2, stderr: "error: unexpected argument '--step-schema' found" });
    expect(e.code).toBe("FORGE_OUTDATED");
  });
  it("tells failed features from an empty document", () => {
    expect(classifyFailure({ ...base, exitCode: 1, stderr: "aicad: p/f: SKETCH_OPEN x\naicad: nothing written" }).code).toBe(
      "EXPORT_FEATURES_FAILED",
    );
    expect(
      classifyFailure({ ...base, exitCode: 1, stderr: "aicad: the document produced no bodies; nothing to export" }).code,
    ).toBe("EXPORT_NO_BODIES");
  });
  it("passes a host error through", () => {
    expect(classifyFailure({ ...base, exitCode: null, error: "aicad timed out" })).toMatchObject({
      code: "EXPORT_FAILED",
      message: "aicad timed out",
    });
  });
});

describe("stepFileName", () => {
  it("keeps readable names and replaces path characters", () => {
    expect(stepFileName("Klammer ü")).toBe("Klammer ü.step");
    expect(stepFileName("a/b:c")).toBe("a_b_c.step");
    expect(stepFileName("  ")).toBe("part.step");
  });
});

describe("STEP in the export dialog (stepExportFormat)", () => {
  const engine = {} as never;
  it("exports AP214 through the host and returns the bytes for the document layer to write", async () => {
    const { host: h, rec } = host({ data: STEP_BYTES, summary: SUMMARY, exitCode: 0, stderr: "" });
    const f = stepExportFormat(h);
    expect(f.id).toBe("step");
    expect(f.extensions[0]).toBe("step");
    expect(f.available({ engine })).toEqual({ ok: true });
    expect(await f.run({ irJson: "{}", engine, name: "plate" })).toBe(STEP_BYTES);
    expect(rec.requests).toEqual([{ irJson: "{}", schema: "ap214", productName: "plate", allowPartial: false }]);
    expect(rec.dialogs).toEqual([]);
    expect(rec.writes).toEqual([]);
  });

  it("is unavailable without the host's Forge CLI, and a refusal keeps its code", async () => {
    expect(stepExportFormat(host(null).host).available({ engine })).toMatchObject({ ok: false, reason: /desktop app's Forge engine/ });
    const refused = stepExportFormat(host({ data: null, summary: { error: { code: "STEP_UNSUPPORTED_SEAM", message: "a seam it cannot write" } }, exitCode: 3, stderr: "" }).host);
    await expect(refused.run({ irJson: "{}", engine, name: "plate" })).rejects.toMatchObject({ code: "STEP_UNSUPPORTED_SEAM", message: /a seam it cannot write \(STEP_UNSUPPORTED_SEAM\)/ });
  });
});

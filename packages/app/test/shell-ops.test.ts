import type { IrDocument } from "@aicad/ir-types";
import { describe, expect, it } from "vitest";
import { applyOpsV0, OpRefusal, parsePointer, v0OpsPort } from "../src/tools/framework/v0-ops";
import { BOX, makeHarness } from "./helpers";

const DOC: IrDocument = {
  schema: "aicad.ir/0",
  parts: [
    {
      id: "p",
      name: "plate",
      features: [
        { type: "sketch", id: "s1", name: "outline", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 5 }] },
        { type: "extrude", id: "e1", name: "plate", sketch: "s1", distance: 5 },
      ],
    },
  ],
};

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof OpRefusal) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("the IR v0 ops (the shell's default until the v1 store is bound)", () => {
  it("setField sets a field by JSON pointer, by feature id or name, without touching the input", () => {
    const next = applyOpsV0(DOC, [
      { op: "setField", feature: "plate", path: "/distance", value: 8 },
      { op: "setField", feature: "s1", path: "/curves/0/radius", value: 7 },
    ]);
    expect(next.parts[0]!.features[1]).toMatchObject({ distance: 8 });
    expect(next.parts[0]!.features[0]).toMatchObject({ curves: [{ radius: 7 }] });
    expect(DOC.parts[0]!.features[1]).toMatchObject({ distance: 5 });
  });

  it("refuses what it can't do, with a COMMAND_* code, and never half-applies", () => {
    expect(refusal(() => applyOpsV0(DOC, [{ op: "setField", feature: "nope", path: "/distance", value: 1 }]))).toMatchObject({ code: "COMMAND_UNKNOWN_FEATURE" });
    expect(refusal(() => applyOpsV0(DOC, [{ op: "setField", feature: "plate", path: "/id", value: "x" }]))).toMatchObject({ code: "COMMAND_FIXED_FIELD" });
    expect(refusal(() => applyOpsV0(DOC, [{ op: "setField", feature: "plate", path: "distance", value: 1 }]))).toMatchObject({ code: "COMMAND_BAD_PATH" });
    expect(refusal(() => applyOpsV0(DOC, [{ op: "setField", feature: "s1", path: "/curves/3/radius", value: 1 }]))).toMatchObject({ code: "COMMAND_BAD_PATH" });
    expect(refusal(() => applyOpsV0(DOC, [{ op: "setField", feature: "plate", path: "/__proto__/x", value: 1 }]))).toMatchObject({ code: "COMMAND_BAD_PATH" });
    expect(refusal(() => applyOpsV0(DOC, [{ op: "setField", feature: "plate", path: "/distance", value: { expr: "wall * 2" } }]))).toMatchObject({ code: "COMMAND_NO_EXPRESSIONS" });
    // The result must be a valid document: a wrong type or an unknown field is refused.
    expect(refusal(() => applyOpsV0(DOC, [{ op: "setField", feature: "plate", path: "/distance", value: "thick" }]))).toMatchObject({ code: "COMMAND_SCHEMA", message: expect.stringContaining("/parts/0/features/1/distance") });
    expect(refusal(() => applyOpsV0(DOC, [{ op: "setField", feature: "plate", path: "/depth", value: 3 }]))).toMatchObject({ code: "COMMAND_SCHEMA" });
    // The second op of two fails: the error says which, and the input is unchanged.
    const r = refusal(() => applyOpsV0(DOC, [{ op: "setField", feature: "plate", path: "/distance", value: 9 }, { op: "setSuppressed", feature: "gone", suppressed: true }]));
    expect(r).toMatchObject({ code: "COMMAND_UNKNOWN_FEATURE", message: expect.stringContaining("op 2 (setSuppressed)") });
    expect(DOC.parts[0]!.features[1]).toMatchObject({ distance: 5 });
    expect(refusal(() => applyOpsV0(DOC, [{ op: "renameParam" } as never]))).toMatchObject({ code: "COMMAND_NOT_IMPLEMENTED" });
  });

  it("setSuppressed and addFeature (C9 ids: <type><n>; names stay unique)", () => {
    const next = applyOpsV0(DOC, [
      { op: "setSuppressed", feature: "plate", suppressed: true },
      { op: "addFeature", part: "plate", after: "plate", feature: { type: "extrude", sketch: "s1", distance: 2 } },
      { op: "addFeature", part: "p", after: null, feature: { type: "sketch", plane: "XZ", curves: [] } },
    ]);
    expect(next.parts[0]!.features.map((f) => [f.id, f.name])).toEqual([
      ["sketch1", "sketch1"],
      ["s1", "outline"],
      ["e1", "plate"],
      ["extrude1", "extrude1"],
    ]);
    expect(next.parts[0]!.features[2]!.suppressed).toBe(true);
    expect(applyOpsV0(next, [{ op: "setSuppressed", feature: "plate", suppressed: false }]).parts[0]!.features[2]).not.toHaveProperty("suppressed");
    expect(refusal(() => applyOpsV0(DOC, [{ op: "addFeature", part: "p", after: null, feature: { type: "extrude", name: "plate", sketch: "s1", distance: 1 } }]))).toMatchObject({ code: "COMMAND_DUPLICATE_NAME" });
    expect(refusal(() => applyOpsV0(DOC, [{ op: "addFeature", part: "p", after: "zzz", feature: { type: "extrude", sketch: "s1", distance: 1 } }]))).toMatchObject({ code: "COMMAND_UNKNOWN_FEATURE" });
    expect(refusal(() => applyOpsV0(DOC, [{ op: "addFeature", part: "q", after: null, feature: { type: "extrude" } }]))).toMatchObject({ code: "COMMAND_UNKNOWN_PART" });
  });

  it("parses JSON pointers (RFC 6901 escapes)", () => {
    expect(parsePointer("/a/b~1c/~0d")).toEqual(["a", "b/c", "~d"]);
  });
});

describe("the IR v0 ops port", () => {
  it("applies ops to the current source as one undo step, keeping the code's comments", async () => {
    const h = await makeHarness({ source: BOX });
    const port = v0OpsPort(h.services, (cmd, source) => h.commands.executeUnknown(cmd, { source }));
    expect(await port.apply([{ op: "setField", feature: "plate", path: "/distance", value: 12 }], { label: "Plate 12 mm", source: "ui" })).toEqual({ ok: true });
    const s = h.services.doc.getState();
    expect(s.source).toContain("distance: 12");
    expect(s.source).toContain("// The outline.");
    expect(s.history.undoLabel).toBe("Plate 12 mm");
    expect(await port.apply([], { label: "nothing", source: "ui" })).toEqual({ ok: true });
    expect(h.services.doc.getState().history.undoLabel).toBe("Plate 12 mm");
  });

  it("refuses with COMMAND_STALE, changing nothing, when the document changes while the edit is prepared", async () => {
    const h = await makeHarness({ source: BOX });
    const other = BOX.replace("distance: 5", "distance: 7");
    const splice = h.services.cadscript.applyIrEdit.bind(h.services.cadscript);
    const services = {
      ...h.services,
      cadscript: {
        ...h.services.cadscript,
        applyIrEdit: async (...a: Parameters<typeof splice>) => {
          const r = await splice(...a);
          h.services.doc.setSource(other, { label: "Someone else" });
          return r;
        },
      },
    };
    const port = v0OpsPort(services, (cmd, source) => h.commands.executeUnknown(cmd, { source }));
    const r = await port.apply([{ op: "setField", feature: "plate", path: "/distance", value: 12 }], { label: "Plate 12 mm", source: "ui" });
    expect(r).toMatchObject({ ok: false, errors: [{ code: "COMMAND_STALE" }] });
    expect(h.services.doc.getState().source).toBe(other);
  });

  it("refuses while the code has errors", async () => {
    const h = await makeHarness({ source: `${BOX}\nconst broken = ;\n` });
    const port = v0OpsPort(h.services, (cmd, source) => h.commands.executeUnknown(cmd, { source }));
    expect(await port.apply([{ op: "setField", feature: "plate", path: "/distance", value: 12 }], { label: "x", source: "ui" })).toMatchObject({ ok: false, errors: [{ code: "COMMAND_CODE_ERRORS" }] });
  });
});

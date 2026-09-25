/**
 * The Thread tool (`feature.thread`, SPEC-v1 §6.13): the face reference it writes for a picked face,
 * the standards it offers, and the ops it commits (the same `tool.start` command the agent calls).
 */
import { describe, expect, it } from "vitest";
import { faceRefForKey, THREAD_CHOICES, threadTool } from "../src/tools/builtin/features";
import type { NumberValue, PanelSpec, PanelValues, ToolContext } from "../src/tools/framework/types";

const num = (text: string, value: number | null): NumberValue => ({ text, value, expression: false, canonical: value === null ? null : String(value) });

function panel(): PanelSpec {
  const ctx = { services: {}, args: {} } as unknown as ToolContext;
  return threadTool.activate(ctx) as PanelSpec;
}

describe("feature.thread", () => {
  it("references a hole wall, a boss side and a cap by query, nothing else", () => {
    expect(faceRefForKey("f_h/wall@a")).toEqual({ kind: "face", q: { op: "hole_face", feature: "f_h", at: "a", part: "wall" } });
    expect(faceRefForKey("f_e2/side:ring")).toEqual({ kind: "face", q: { op: "side", feature: "f_e2", curve: "ring" } });
    expect(faceRefForKey("f_e/cap:end")).toEqual({ kind: "face", q: { op: "cap", feature: "f_e", end: "end" } });
    expect(faceRefForKey("f_t/thread_root@a")).toBeNull();
    expect(faceRefForKey("f_e/edge:{f_e/cap:end|f_e/side:o.left}")).toBeNull();
  });

  it("offers the THREAD_STANDARDS designations, metric first, 1/2-20 UNF included", () => {
    const values = THREAD_CHOICES.map((o) => o.value);
    expect(values[0]).toBe("M1.6");
    expect(values).toContain("M8");
    expect(values).toContain("M14x1");
    expect(values).toContain("1/2-20 UNF");
    expect(values.indexOf("M30")).toBeLessThan(values.indexOf("#2-56 UNC"));
    expect(THREAD_CHOICES.find((o) => o.value === "1/2-20 UNF")?.hint).toBe("Ø12.7 mm × P1.27 mm");
  });

  it("commits one addFeature of a thread on the picked face", async () => {
    const p = panel();
    const values: PanelValues = {
      face: [{ kind: "face", part: "p_plate", key: "f_h/wall@a" }],
      standard: "1/2-20 UNF",
      length: num("12", 12),
      kind: "modeled",
      hand: "right",
    };
    expect(p.validate?.(values)).toEqual([]);
    expect(await p.toOps!(values)).toEqual([
      { op: "addFeature", part: "p_plate", feature: { type: "thread", face: { kind: "face", q: { op: "hole_face", feature: "f_h", at: "a", part: "wall" } }, standard: "1/2-20 UNF", length: 12 } },
    ]);
    // Cosmetic, left hand, the whole face.
    const cosmetic = await p.toOps!({ ...values, length: num("", null), kind: "cosmetic", hand: "left" });
    expect((cosmetic[0] as { feature: Record<string, unknown> }).feature).toEqual({
      type: "thread",
      face: { kind: "face", q: { op: "hole_face", feature: "f_h", at: "a", part: "wall" } },
      standard: "1/2-20 UNF",
      hand: "left",
      modeled: false,
    });
  });

  it("refuses a face it cannot reference", () => {
    const errors = panel().validate?.({ face: [{ kind: "face", part: "p", key: "f_x/fillet:0" }], standard: "M8", kind: "modeled", hand: "right" });
    expect(errors?.[0]?.field).toBe("face");
  });

  it("re-edits a thread with updateFeature", async () => {
    const edit = threadTool.fromFeature!({ id: "f_t", name: "rearThread", type: "thread", part: "p", json: { type: "thread", standard: "M8", length: 10 } }, {} as ToolContext) as PanelSpec;
    const ops = await edit.toOps!({ standard: "1/2-20 UNF", length: num("10", 10), kind: "modeled", hand: "right" });
    expect(ops).toEqual([{ op: "updateFeature", feature: "f_t", set: { standard: "1/2-20 UNF" } }]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { staticParamsPort, staticSelectionPort } from "../src/tools/framework/ports";
import { PanelSession, selectionNoun } from "../src/tools/framework/session";
import type { NumberValue, PanelSpec, PreviewOutcome, SelectionItem } from "../src/tools/framework/types";

const edge = (key: string): SelectionItem => ({ kind: "edge", part: "part", key, body: "part/slab" });
const face = (key: string): SelectionItem => ({ kind: "face", part: "part", key, body: "part/slab" });

function filletSpec(overrides: Partial<PanelSpec> = {}): PanelSpec {
  return {
    title: "Fillet",
    fields: [
      { kind: "selection", key: "edges", label: "Edges", accepts: ["edge"] },
      { kind: "number", key: "r", label: "Radius", quantity: "length", min: 0, minExclusive: true, default: "2" },
      { kind: "choice", key: "mode", label: "Mode", options: [{ value: "round", label: "Round" }, { value: "flat", label: "Flat" }] },
      { kind: "toggle", key: "chain", label: "Tangent chain", default: true },
    ],
    previewDelayMs: 0,
    ...overrides,
  };
}

function open(spec: PanelSpec, selection: SelectionItem[] = [], onClose = vi.fn()) {
  const sel = staticSelectionPort(selection);
  const session = new PanelSession(spec, { id: 1, toolId: "feature.fillet", params: staticParamsPort([{ name: "wall", unit: "mm", value: 2 }]), selection: sel, onClose });
  return { session, sel, onClose };
}

describe("panel sessions", () => {
  it("prefills a selection input from the current selection and ignores other kinds", () => {
    const { session } = open(filletSpec(), [edge("e1"), face("f1"), edge("e2")]);
    const s = session.getState();
    const edges = s.fields.find((f) => f.key === "edges")!;
    expect(edges.value).toEqual([edge("e1"), edge("e2")]);
    expect(edges.ignored).toBe(1);
    expect(s.activeSelectionField).toBe("edges");
    expect(session.values()["mode"]).toBe("round");
    expect(session.values()["chain"]).toBe(true);
  });

  it("waits for required input, then becomes ready", () => {
    const { session, sel } = open(filletSpec());
    expect(session.getState().state).toBe("collecting");
    expect(session.getState().fields.find((f) => f.key === "edges")!.error).toMatchObject({ code: "REQUIRED", message: "Select edges." });
    sel.set([edge("e1")]);
    expect(session.getState().state).toBe("ready");
    expect((session.values()["edges"] as SelectionItem[]).length).toBe(1);
  });

  it("checks number fields as they are typed", () => {
    const { session } = open(filletSpec(), [edge("e1")]);
    session.set("r", "wall * 1.5");
    const v = session.values()["r"] as NumberValue;
    expect(v).toMatchObject({ value: 3, expression: true, canonical: "wall * 1.5" });
    session.set("r", "-1");
    expect(session.getState().state).toBe("collecting");
    expect(session.getState().fields.find((f) => f.key === "r")!.error?.code).toBe("OUT_OF_RANGE");
  });

  it("runs the live preview and maps its errors, with the feasible range, to the field", async () => {
    const preview = vi.fn(async (values): Promise<PreviewOutcome> => {
      const r = (values["r"] as NumberValue).value!;
      return r > 3.41 ? { ok: false, errors: [{ field: "r", code: "FILLET_TOO_LARGE", message: "The wall would vanish.", feasible: { min: 0, max: 3.41 } }] } : { ok: true, summary: [{ label: "Faces", value: "4" }] };
    });
    const commit = vi.fn().mockResolvedValue({ ok: true });
    const { session } = open(filletSpec({ preview, commit }), [edge("e1")]);
    await session.settled();
    expect(session.getState().state).toBe("ready");
    expect(session.getState().summary).toEqual([{ label: "Faces", value: "4" }]);
    session.set("r", "5");
    await session.settled();
    const s = session.getState();
    expect(s.state).toBe("invalid");
    expect(s.fields.find((f) => f.key === "r")!.remoteError).toMatchObject({ code: "FILLET_TOO_LARGE", feasible: { max: 3.41 } });
    const blocked = await session.commit();
    expect(blocked).toMatchObject({ ok: false, errors: [{ code: "FILLET_TOO_LARGE" }] });
    expect(commit).not.toHaveBeenCalled();
    session.set("r", "3.41");
    expect(session.getState().fields.find((f) => f.key === "r")!.remoteError).toBeNull();
    await session.settled();
    expect(session.getState().state).toBe("ready");
  });

  it("drops a stale preview when a newer one started", async () => {
    let release: (() => void) | null = null;
    const seen: string[] = [];
    const preview = vi.fn((values, io: { signal: AbortSignal }): Promise<PreviewOutcome> => {
      const text = (values["r"] as NumberValue).text;
      seen.push(text);
      if (text === "1") {
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, summary: [{ label: "r", value: "stale" }] });
          io.signal.addEventListener("abort", () => undefined);
        });
      }
      return Promise.resolve({ ok: true, summary: [{ label: "r", value: text }] });
    });
    const { session } = open(filletSpec({ preview, fields: [{ kind: "number", key: "r", label: "Radius", quantity: "length", default: "1" }] }));
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(["1"]);
    session.set("r", "2");
    await session.settled();
    release!();
    await new Promise((r) => setTimeout(r, 5));
    expect(session.getState().summary).toEqual([{ label: "r", value: "2" }]);
  });

  it("commits once and closes on OK; keeps the panel open with the errors when the commit fails", async () => {
    const commit = vi.fn().mockResolvedValueOnce({ ok: false, errors: [{ field: "r", code: "COMMAND_FEATURE_FAILS", message: "no" }] }).mockResolvedValueOnce({ ok: true });
    const { session, onClose } = open(filletSpec({ commit }), [edge("e1")]);
    const first = await session.commit();
    expect(first.ok).toBe(false);
    expect(session.getState().state).toBe("invalid");
    expect(session.closed).toBe(false);
    session.set("r", "1");
    const second = await session.commit();
    expect(second.ok).toBe(true);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(session.closed).toBe(true);
    expect(onClose).toHaveBeenCalledWith("ok", session);
  });

  it("does not commit while input is missing", async () => {
    const commit = vi.fn();
    const { session } = open(filletSpec({ commit }));
    const r = await session.commit();
    expect(r).toMatchObject({ ok: false, errors: [{ code: "REQUIRED" }] });
    expect(commit).not.toHaveBeenCalled();
  });

  it("Apply commits and starts over with the initial values", async () => {
    const commit = vi.fn().mockResolvedValue({ ok: true });
    const { session } = open(filletSpec({ commit, apply: true }), [edge("e1")]);
    session.set("r", "4");
    await session.apply();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(session.closed).toBe(false);
    expect((session.values()["r"] as NumberValue).text).toBe("2");
  });

  it("Cancel runs the tool's cleanup and never commits", () => {
    const cancel = vi.fn();
    const commit = vi.fn();
    const { session, onClose } = open(filletSpec({ cancel, commit }), [edge("e1")]);
    session.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("cancel", session);
    session.set("r", "3");
    expect(session.getState().state).toBe("closed");
  });

  it("closes a read-only panel on OK without a commit", async () => {
    const { session } = open({ title: "Info", readOnly: true, fields: [] });
    expect(session.getState().state).toBe("ready");
    expect((await session.commit()).ok).toBe(true);
    expect(session.closed).toBe(true);
  });

  it("applies cross-field checks and hides fields with visibleWhen", () => {
    const spec: PanelSpec = {
      title: "Chamfer",
      fields: [
        { kind: "choice", key: "kind", label: "Type", options: [{ value: "equal", label: "Equal" }, { value: "two", label: "Two distances" }] },
        { kind: "number", key: "d", label: "Distance", quantity: "length", default: "1" },
        { kind: "number", key: "d2", label: "Second", quantity: "length", default: "", visibleWhen: (v) => v["kind"] === "two" },
      ],
      validate: (v) => ((v["d"] as NumberValue).value ?? 0) > 5 ? [{ message: "Too big for this edge." }] : [],
    };
    const { session } = open(spec);
    expect(session.getState().state).toBe("ready");
    expect(session.getState().fields.find((f) => f.key === "d2")!.visible).toBe(false);
    session.set("kind", "two");
    expect(session.getState().state).toBe("collecting");
    session.set("d2", "2");
    expect(session.getState().state).toBe("ready");
    session.set("d", "6");
    expect(session.getState().errors).toEqual([{ message: "Too big for this edge." }]);
    expect(() => session.set("kind", "nope")).toThrow(/not one of/);
  });

  it("an active selection input follows the selection; another input can take over", () => {
    const spec: PanelSpec = {
      title: "Boolean",
      fields: [
        { kind: "selection", key: "targets", label: "Targets", accepts: ["body"] },
        { kind: "selection", key: "tools", label: "Tools", accepts: ["body"], fromSelection: false },
      ],
    };
    const b = (n: string): SelectionItem => ({ kind: "body", part: "part", body: n });
    const { session, sel } = open(spec, [b("a")]);
    session.activateSelectionField("tools");
    sel.set([b("b"), b("c")]);
    expect(session.values()["targets"]).toEqual([b("a")]);
    expect(session.values()["tools"]).toEqual([b("b"), b("c")]);
    session.clearSelectionField("tools");
    expect(session.values()["tools"]).toEqual([]);
  });

  it("names selection counts", () => {
    expect(selectionNoun(["edge"], 1)).toBe("1 edge");
    expect(selectionNoun(["face"], 3)).toBe("3 faces");
    expect(selectionNoun(["edge", "face"], 2)).toBe("2 items");
  });
});

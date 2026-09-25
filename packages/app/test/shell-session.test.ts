import { describe, expect, it, vi } from "vitest";
import type { RenderBody } from "../src/engine/types";
import { staticDocumentPort, staticParamsPort, staticSelectionPort } from "../src/tools/framework/ports";
import { PanelSession, selectionNoun, type PanelSessionOptions } from "../src/tools/framework/session";
import type { CommitOutcome, DocumentPort, NumberValue, OpsPort, PanelSpec, PreviewOutcome, SelectionItem } from "../src/tools/framework/types";

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

function open(spec: PanelSpec, selection: SelectionItem[] = [], onClose = vi.fn(), extra: Partial<PanelSessionOptions> = {}) {
  const sel = staticSelectionPort(selection);
  const doc = staticDocumentPort();
  const drawn: Array<{ bodies: readonly RenderBody[] | null; stale: boolean }> = [];
  const session = new PanelSession(spec, {
    id: 1,
    toolId: "feature.fillet",
    params: staticParamsPort([{ name: "wall", unit: "mm", value: 2 }]),
    selection: sel,
    document: doc,
    onClose,
    onPreviewBodies: (bodies, stale) => drawn.push({ bodies, stale }),
    ...extra,
  });
  return { session, sel, onClose, doc, drawn };
}

/** A stand-in render body, told apart by its name. */
const bodyNamed = (name: string): RenderBody => ({ name, positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), faceRanges: [], edges: [] });

/** A promise the test resolves by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A radius panel whose preview the test answers per value; `bodies` name the value they preview. */
function radiusPanel(answers: Map<string, ReturnType<typeof deferred<PreviewOutcome>>>, over: Partial<PanelSpec> = {}): PanelSpec {
  return {
    title: "Fillet",
    fields: [{ kind: "number", key: "r", label: "Radius", quantity: "length", default: "1" }],
    previewDelayMs: 0,
    preview: (values) => {
      const text = (values["r"] as NumberValue).text;
      const d = answers.get(text);
      return d ? d.promise : Promise.resolve({ ok: true, bodies: [bodyNamed(`r=${text}`)] });
    },
    ...over,
  };
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

  it("initial values (tool.start args) are checked: numbers may be numbers, unknown inputs are refused", () => {
    const { session } = open(filletSpec({ initial: { r: 3, mode: "flat" } }), [edge("e1")]);
    expect(session.values()["r"]).toMatchObject({ text: "3", value: 3 });
    expect(session.values()["mode"]).toBe("flat");
    expect(() => open(filletSpec({ initial: { radius: 3 } }))).toThrow(/has no input radius \(its inputs: edges, r, mode, chain\)/);
    expect(() => open(filletSpec({ initial: { mode: "oval" } }))).toThrow(/not one of round, flat/);
    expect(() => open(filletSpec({ initial: { edges: "e1" } }))).toThrow(/list of selected items/);
    expect(() => open(filletSpec({ toOps: () => [], commit: () => ({ ok: true }) }))).toThrow(/both toOps and commit/);
  });

  it("names selection counts", () => {
    expect(selectionNoun(["edge"], 1)).toBe("1 edge");
    expect(selectionNoun(["face"], 3)).toBe("3 faces");
    expect(selectionNoun(["edge", "face"], 2)).toBe("2 items");
  });
});

describe("preview geometry follows only the current preview", () => {
  it("a slow older preview never replaces a newer one's bodies", async () => {
    const slow = deferred<PreviewOutcome>();
    const { session, drawn } = open(radiusPanel(new Map([["5", slow]]), { fields: [{ kind: "number", key: "r", label: "Radius", quantity: "length", default: "5" }] }));
    await tick();
    expect(session.getState().state).toBe("previewing");
    session.set("r", "6");
    await session.settled();
    expect(drawn.at(-1)).toEqual({ bodies: [bodyNamed("r=6")], stale: false });
    // The 5 mm preview answers last: dropped, bodies included.
    slow.resolve({ ok: true, bodies: [bodyNamed("r=5")] });
    await tick();
    expect(drawn.some((d) => d.bodies?.[0]?.name === "r=5")).toBe(false);
    expect(drawn.at(-1)!.bodies![0]!.name).toBe("r=6");
    expect(session.getState().state).toBe("ready");
  });

  it("a preview that answers after Cancel draws nothing", async () => {
    const slow = deferred<PreviewOutcome>();
    const { session, drawn } = open(radiusPanel(new Map([["1", slow]])));
    await tick();
    const before = drawn.length;
    session.cancel();
    slow.resolve({ ok: true, bodies: [bodyNamed("late")] });
    await tick();
    expect(drawn.length).toBe(before);
    expect(drawn.some((d) => d.bodies?.[0]?.name === "late")).toBe(false);
  });

  it("marks the drawn bodies stale while newer values are checked, and draws nothing for values that don't check", async () => {
    const slow = deferred<PreviewOutcome>();
    const { session, drawn } = open(radiusPanel(new Map([["7", slow]]), { fields: [{ kind: "number", key: "r", label: "Radius", quantity: "length", min: 0, default: "1" }] }));
    await session.settled();
    expect(drawn.at(-1)).toEqual({ bodies: [bodyNamed("r=1")], stale: false });
    session.set("r", "7");
    expect(drawn.at(-1)).toEqual({ bodies: [bodyNamed("r=1")], stale: true });
    slow.resolve({ ok: false, errors: [{ field: "r", code: "FILLET_TOO_LARGE", message: "too big" }] });
    await session.settled();
    expect(drawn.at(-1)).toEqual({ bodies: null, stale: false });
    session.set("r", "-1");
    expect(session.getState().state).toBe("collecting");
    expect(drawn.at(-1)).toEqual({ bodies: null, stale: false });
  });
});

describe("OK commits only checked values", () => {
  it("OK while the preview runs waits for it, then commits the values it checked", async () => {
    const slow = deferred<PreviewOutcome>();
    const commit = vi.fn(async (): Promise<CommitOutcome> => ({ ok: true }));
    const { session } = open(radiusPanel(new Map([["11", slow]]), { commit }));
    await session.settled();
    session.set("r", "11");
    expect(session.getState().state).toBe("previewing");
    const ok = session.commit();
    await tick();
    expect(session.getState().pendingCommit).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    // A second OK meanwhile does nothing.
    expect(await session.commit()).toMatchObject({ ok: false, errors: [{ code: "BUSY" }] });
    slow.resolve({ ok: true });
    expect(await ok).toEqual({ ok: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect((commit.mock.calls[0] as unknown as [Record<string, NumberValue>])[0]["r"]!.value).toBe(11);
    expect(session.closed).toBe(true);
  });

  it("OK while the preview runs does not commit when the check fails", async () => {
    const slow = deferred<PreviewOutcome>();
    const commit = vi.fn();
    const { session } = open(radiusPanel(new Map([["11", slow]]), { commit }));
    await session.settled();
    session.set("r", "11");
    const ok = session.commit();
    slow.resolve({ ok: false, errors: [{ field: "r", code: "FILLET_TOO_LARGE", message: "The wall would vanish.", feasible: { max: 3.4 } }] });
    expect(await ok).toMatchObject({ ok: false, errors: [{ code: "FILLET_TOO_LARGE" }] });
    expect(commit).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({ state: "invalid", pendingCommit: false });
    expect(session.closed).toBe(false);
  });

  it("OK runs a debounced preview at once instead of waiting for the delay", async () => {
    const preview = vi.fn(async (): Promise<PreviewOutcome> => ({ ok: true }));
    const commit = vi.fn(async (): Promise<CommitOutcome> => ({ ok: true }));
    const { session } = open(radiusPanel(new Map(), { preview, commit, previewDelayMs: 60_000 }));
    await tick();
    const calls = preview.mock.calls.length;
    session.set("r", "2");
    const t0 = Date.now();
    expect((await session.commit()).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(preview.mock.calls.length).toBe(calls + 1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("Cancel while OK waits: nothing is committed", async () => {
    const slow = deferred<PreviewOutcome>();
    const commit = vi.fn();
    const { session } = open(radiusPanel(new Map([["11", slow]]), { commit }));
    await session.settled();
    session.set("r", "11");
    const ok = session.commit();
    await tick();
    session.cancel();
    expect(await ok).toMatchObject({ ok: false, errors: [{ code: "CLOSED" }] });
    slow.resolve({ ok: true });
    await tick();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("the panel follows the document", () => {
  it("a document change re-runs the preview (a read-only panel refreshes its numbers)", async () => {
    let volume = 100;
    const { session, doc } = open({ title: "Body properties", readOnly: true, fields: [], previewDelayMs: 0, preview: () => ({ ok: true, summary: [{ label: "Volume", value: String(volume) }] }) });
    await session.settled();
    expect(session.getState().summary).toEqual([{ label: "Volume", value: "100" }]);
    volume = 250; // e.g. undo
    doc.bump();
    await session.settled();
    expect(session.getState().summary).toEqual([{ label: "Volume", value: "250" }]);
  });

  it("a document change aborts the preview running against the old document", async () => {
    const slow = deferred<PreviewOutcome>();
    const signals: AbortSignal[] = [];
    const revisions: number[] = [];
    const { session, doc, drawn } = open(
      radiusPanel(new Map(), {
        preview: (_v, io) => {
          signals.push(io.signal);
          revisions.push(io.revision);
          return revisions.length === 1 ? slow.promise : Promise.resolve({ ok: true, bodies: [bodyNamed("new document")] });
        },
      }),
    );
    await tick();
    doc.bump();
    await session.settled();
    expect(signals[0]!.aborted).toBe(true);
    expect(revisions).toEqual([0, 1]);
    slow.resolve({ ok: true, bodies: [bodyNamed("old document")] });
    await tick();
    expect(drawn.at(-1)!.bodies![0]!.name).toBe("new document");
  });

  it("OK re-checks a preview that passed against an older revision before committing", async () => {
    let rev = 0;
    // A port whose revision moves without telling (the check must not rely on the event alone).
    const quiet: DocumentPort = { revision: () => rev, subscribe: () => () => undefined, feature: () => null };
    const preview = vi.fn(async (): Promise<PreviewOutcome> => ({ ok: true }));
    const commit = vi.fn(async (): Promise<CommitOutcome> => ({ ok: true }));
    const { session } = open(radiusPanel(new Map(), { preview, commit }), [], vi.fn(), { document: quiet });
    await session.settled();
    expect(preview).toHaveBeenCalledTimes(1);
    rev = 1;
    expect((await session.commit()).ok).toBe(true);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("toOps are applied as one transaction, labelled, with who pressed OK", async () => {
    const apply = vi.fn(async (): Promise<CommitOutcome> => ({ ok: true }));
    const ops: OpsPort = { apply };
    const { session } = open(
      radiusPanel(new Map(), { toOps: (v) => [{ op: "setField", feature: "fillet1", path: "/r", value: (v["r"] as NumberValue).value }], label: (v) => `Fillet ${(v["r"] as NumberValue).text} mm` }),
      [],
      vi.fn(),
      { ops },
    );
    session.set("r", "2.5");
    expect((await session.commit("agent")).ok).toBe(true);
    expect(apply).toHaveBeenCalledWith([{ op: "setField", feature: "fillet1", path: "/r", value: 2.5 }], { label: "Fillet 2.5 mm", source: "agent" });
  });

  it("a commit refused because the part changed under it is checked again, and the user is told", async () => {
    const apply = vi.fn(async (): Promise<CommitOutcome> => ({ ok: false, errors: [{ code: "COMMAND_STALE", message: "The part changed" }] }));
    const preview = vi.fn(async (): Promise<PreviewOutcome> => ({ ok: true }));
    const { session } = open(radiusPanel(new Map(), { preview, toOps: () => [{ op: "setSuppressed", feature: "f", suppressed: true }] }), [], vi.fn(), { ops: { apply } });
    await session.settled();
    const r = await session.commit();
    expect(r).toMatchObject({ ok: false, errors: [{ code: "COMMAND_STALE" }] });
    expect(session.getState().notice).toMatch(/changed while this change was being applied/);
    await session.settled();
    expect(session.getState().state).toBe("ready");
    expect(preview).toHaveBeenCalledTimes(2);
    session.set("r", "2");
    expect(session.getState().notice).toBeNull();
  });

  it("toOps without an ops port is refused, not ignored", async () => {
    const { session } = open(radiusPanel(new Map(), { toOps: () => [] }));
    expect(await session.commit()).toMatchObject({ ok: false, errors: [{ code: "NO_OPS_PORT" }] });
  });
});

import { describe, expect, it } from "vitest";
import { compile } from "@aicad/cadscript";
import { InlineCadScriptService } from "../src/cadscript/inline-service";
import { DocStore } from "../src/doc/doc-store";
import { History } from "../src/doc/history";
import { applyEdit, diffText, invertEdit } from "../src/doc/text-edit";
import { BOX, FakeEngine } from "./helpers";

function makeStore(engine = new FakeEngine(), clock = { t: 0 }): { store: DocStore; engine: FakeEngine; clock: { t: number } } {
  const store = new DocStore({ cadscript: new InlineCadScriptService(), engine: () => engine, debounceMs: 0, now: () => clock.t });
  return { store, engine, clock };
}

describe("text edits", () => {
  it("diff → apply → invert round-trips", () => {
    const cases: Array<[string, string]> = [
      ["abc", "abXc"],
      ["hello world", "hello"],
      ["", "new"],
      ["same", "same"],
      ["a😀b", "a😃b"],
    ];
    for (const [before, after] of cases) {
      const e = diffText(before, after);
      expect(applyEdit(before, e)).toBe(after);
      expect(applyEdit(after, invertEdit(e))).toBe(before);
    }
    expect(diffText("abc", "abXc")).toEqual({ offset: 2, removed: "", inserted: "X" });
  });

  it("refuses to apply an edit to text it was not made for", () => {
    expect(() => applyEdit("xyz", { offset: 0, removed: "abc", inserted: "" })).toThrow(/does not apply/);
  });
});

describe("History", () => {
  it("undoes and redoes transactions in order and clears redo on a new edit", () => {
    const h = new History();
    let text = "a";
    const set = (next: string, t: number): void => {
      h.record(text, next, { label: "edit", origin: "user", time: t });
      text = next;
    };
    set("ab", 0);
    set("abc", 1);
    let r = h.undo(text)!;
    text = r.text;
    expect(text).toBe("ab");
    r = h.redo(text)!;
    text = r.text;
    expect(text).toBe("abc");
    h.undo(text);
    text = "ab";
    set("abX", 2);
    expect(h.canRedo).toBe(false);
  });

  it("coalesces edits with the same key inside the window, and seals on undo/timeout", () => {
    const h = new History({ coalesceMs: 1000 });
    h.record("", "a", { label: "type", origin: "user", coalesceKey: "editor", time: 0 });
    h.record("a", "ab", { label: "type", origin: "user", coalesceKey: "editor", time: 500 });
    h.record("ab", "abc", { label: "type", origin: "user", coalesceKey: "editor", time: 1200 });
    expect(h.size.undo).toBe(1);
    h.record("abc", "abcd", { label: "type", origin: "user", coalesceKey: "editor", time: 2500 });
    expect(h.size.undo).toBe(2);
    h.seal();
    h.record("abcd", "abcde", { label: "type", origin: "user", coalesceKey: "editor", time: 2600 });
    expect(h.size.undo).toBe(3);
    expect(h.undo("abcde")!.text).toBe("abcd");
    expect(h.undo("abcd")!.text).toBe("abc");
    expect(h.undo("abc")!.text).toBe("");
  });

  it("drops a coalesced transaction whose edits cancel out", () => {
    const h = new History();
    h.record("x", "xy", { label: "type", origin: "user", coalesceKey: "k", time: 0 });
    h.record("xy", "x", { label: "type", origin: "user", coalesceKey: "k", time: 10 });
    expect(h.canUndo).toBe(false);
  });

  it("caps the stack at the limit", () => {
    const h = new History({ limit: 3 });
    let text = "";
    for (let i = 0; i < 5; i++) {
      h.record(text, text + i, { label: `e${i}`, origin: "user", time: i * 10_000 });
      text += i;
    }
    expect(h.size.undo).toBe(3);
  });
});

describe("DocStore pipeline", () => {
  it("compiles and evaluates a loaded document", async () => {
    const { store, engine } = makeStore();
    store.load({ path: null, name: "box", format: "cadscript", source: BOX });
    const s = await store.idle();
    expect(s.compile?.ok).toBe(true);
    expect(s.model?.ir?.parts[0]?.features.map((f) => f.name)).toEqual(["outline", "plate"]);
    expect(s.report?.status).toBe("ok");
    expect(s.bodies.map((b) => b.name)).toEqual(["plate/plate"]);
    expect(s.timings.compileMs).not.toBeNull();
    expect(s.timings.evalMs).not.toBeNull();
    expect(engine.evaluations).toHaveLength(1);
    expect(s.dirty).toBe(false);
  });

  it("records source edits as undoable transactions and tracks dirty state", async () => {
    const { store, clock } = makeStore();
    store.load({ path: null, name: "box", format: "cadscript", source: BOX });
    await store.idle();
    const edited = BOX.replace("distance: 5", "distance: 8");
    // Typing: three coalesced keystrokes are one undo step.
    clock.t = 0;
    store.setSource(BOX.replace("distance: 5", "distance: "), { coalesceKey: "editor" });
    clock.t = 100;
    store.setSource(BOX.replace("distance: 5", "distance: 8"), { coalesceKey: "editor" });
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().history.canUndo).toBe(true);
    let s = await store.idle();
    expect(s.model?.ir?.parts[0]?.features[1]).toMatchObject({ distance: 8 });

    expect(store.undo()).toBe(true);
    s = await store.idle();
    expect(s.source).toBe(BOX);
    expect(s.dirty).toBe(false);
    expect(s.history.canUndo).toBe(false);
    expect(s.model?.ir?.parts[0]?.features[1]).toMatchObject({ distance: 5 });

    expect(store.redo()).toBe(true);
    s = await store.idle();
    expect(s.source).toBe(edited);
    expect(store.redo()).toBe(false);
  });

  it("keeps ids stable across recompiles and after undo", async () => {
    const { store } = makeStore();
    store.load({ path: null, name: "box", format: "cadscript", source: BOX });
    const ids = (await store.idle()).model!.ir!.parts[0]!.features.map((f) => f.id);
    store.setSource(BOX.replace("const plate", "const slab"));
    const renamed = (await store.idle()).model!.ir!.parts[0]!.features.map((f) => f.id);
    expect(renamed).toEqual(ids);
  });

  it("keeps the last good model while the code has errors", async () => {
    const { store, engine } = makeStore();
    store.load({ path: null, name: "box", format: "cadscript", source: BOX });
    await store.idle();
    store.setSource(`${BOX}\nconst broken = extrude(nope, { distance: 1 });\n`);
    const s = await store.idle();
    expect(s.compile?.ok).toBe(false);
    expect(s.compile?.diagnostics.some((d) => d.code === "CS_UNRESOLVED_SKETCH")).toBe(true);
    expect(s.model?.ok).toBe(true);
    expect(s.bodies).toHaveLength(1);
    expect(engine.evaluations).toHaveLength(1);
  });

  it("does not re-evaluate when an edit leaves the IR unchanged", async () => {
    const { store, engine } = makeStore();
    store.load({ path: null, name: "box", format: "cadscript", source: BOX });
    await store.idle();
    store.setSource(BOX.replace("// The outline.", "// The outline, 50 x 50."));
    await store.idle();
    expect(engine.evaluations).toHaveLength(1);
    store.recompute();
    await store.idle();
    expect(engine.evaluations).toHaveLength(2);
  });

  it("drops results of superseded evaluations", async () => {
    const engine = new FakeEngine();
    const { store } = makeStore(engine);
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    let calls = 0;
    engine.gate = () => (calls++ === 0 ? first : Promise.resolve());
    store.load({ path: null, name: "box", format: "cadscript", source: BOX });
    await new Promise((r) => setTimeout(r, 20));
    store.setSource(BOX.replace("distance: 5", "distance: 9"));
    const s = await store.idle();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(JSON.parse(store.getState().evaluatedIrJson!).parts[0].features[1].distance).toBe(9);
    expect(s.phase).toBe("idle");
  });

  it("reports engine failures and clears stale bodies", async () => {
    const engine = new FakeEngine();
    const { store } = makeStore(engine);
    store.load({ path: null, name: "box", format: "cadscript", source: BOX });
    await store.idle();
    engine.fail = "aicad not found";
    store.recompute();
    const s = await store.idle();
    expect(s.engineError).toBe("aicad not found");
    expect(s.bodies).toHaveLength(0);
  });

  it("keeps the ids of an opened IR document", async () => {
    const r = compile(BOX);
    const ir = structuredClone(r.ir!);
    ir.parts[0]!.id = "0199-part-uuid";
    ir.parts[0]!.features[0]!.id = "0199-sketch-uuid";
    ir.parts[0]!.features[1]!.id = "0199-extrude-uuid";
    const { store } = makeStore();
    store.load({ path: "/x.json", name: "x", format: "ir-json", source: BOX, baseIr: ir });
    const s = await store.idle();
    expect(s.model?.ir?.parts[0]?.features.map((f) => f.id)).toEqual(["0199-sketch-uuid", "0199-extrude-uuid"]);
  });

  it("markSaved makes the current source the saved one", async () => {
    const { store } = makeStore();
    store.load({ path: null, name: "box", format: "cadscript", source: BOX });
    store.setSource(`${BOX}\n`);
    expect(store.getState().dirty).toBe(true);
    store.markSaved({ path: "/tmp/box.cad.ts", name: "box", format: "cadscript" });
    expect(store.getState()).toMatchObject({ dirty: false, path: "/tmp/box.cad.ts" });
    await store.idle();
  });
});

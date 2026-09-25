/**
 * The timeline's drag-to-reorder preview (`moveSlots`) against the engine: for every feature of
 * the corpus plate and every place it could be dropped, the slot the timeline shows as valid is
 * exactly a move the command layer accepts, and a slot shown as invalid is one it refuses with
 * `COMMAND_ILLEGAL_ORDER`.
 */
import { applyOp, CommandEngineError } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import { forgeWebCommandEngine, type ForgeWebCommandModule, type IrCommandEngine } from "../src/doc/v1/command-engine";
import { featureRefs, moveSlots, slotForGap, type OrderFeature } from "../src/doc/v1/feature-order";

const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as { existsSync(p: URL): boolean; readFileSync(p: URL, enc?: string): Uint8Array & string };
const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
const hasWasm = fs.existsSync(wasmUrl);
const it_ = hasWasm ? it : it.skip;
const PLATE = fs.readFileSync(new URL("../../../corpus/v1/programs/plate_features.json", import.meta.url), "utf8");

let engine: IrCommandEngine;
beforeAll(async () => {
  if (!hasWasm) return;
  const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
  const mod = (await import(/* @vite-ignore */ entry)) as ForgeWebCommandModule & { init(input: unknown): Promise<void> };
  await mod.init(fs.readFileSync(wasmUrl));
  engine = forgeWebCommandEngine(mod);
}, 60_000);

type Doc = { parts: Array<{ features: Array<{ id: string; name: string }> }> };
const features = (text: string): OrderFeature[] => (JSON.parse(text) as Doc).parts[0]!.features.map((f) => ({ id: f.id, name: f.name, json: f }));

describe("featureRefs", () => {
  it("finds sketches, datums, query sources and pattern seeds, and nothing else", () => {
    const ids = new Set(["s1", "e1", "d1", "h1", "t1", "outline"]);
    expect(featureRefs({ id: "e2", type: "extrude", sketch: "s1", distance: 5 }, ids)).toEqual(["s1"]);
    expect(featureRefs({ id: "s2", type: "sketch", plane: { datum: "d1" }, curves: [{ kind: "rect", id: "outline" }] }, ids)).toEqual(["d1"]);
    expect(featureRefs({ id: "f1", type: "fillet", edges: { kind: "edge", q: { op: "edges", of: { op: "body", feature: "e1" } } }, r: 1 }, ids)).toEqual(["e1"]);
    expect(featureRefs({ id: "p1", type: "pattern", seed: { features: ["h1", "e1"] } }, ids)).toEqual(["h1", "e1"]);
    // A captured member's key and a curve id are not feature references; neither is the feature's own id.
    expect(featureRefs({ id: "t1", type: "tag", name: "e1", target: { q: { op: "tagged", feature: "t1" }, capture: { members: [{ feature: "s1" }] } } }, ids)).toEqual([]);
  });
});

describe("moveSlots", () => {
  it("keeps a feature after what it uses and before what uses it", () => {
    const f = [
      { id: "s1", name: "base", json: { id: "s1", type: "sketch" } },
      { id: "e1", name: "slab", json: { id: "e1", type: "extrude", sketch: "s1" } },
      { id: "s2", name: "free", json: { id: "s2", type: "sketch" } },
      { id: "f1", name: "round", json: { id: "f1", type: "fillet", edges: { q: { op: "body", feature: "e1" } } } },
    ];
    const slots = moveSlots(f, "e1");
    expect(slots.map((s) => [s.after, s.valid, s.current])).toEqual([
      [null, false, false],
      ["s1", true, true],
      ["s2", true, false],
      ["f1", false, false],
    ]);
    expect(slots[0]!.reason).toBe("slab uses base: it must stay after it");
    expect(slots[3]!.reason).toBe("round uses slab: it must stay before it");
    // Gaps in the displayed order: both sides of the dragged chip are its current place.
    expect(slotForGap(slots, 1, 1)?.current).toBe(true);
    expect(slotForGap(slots, 1, 2)?.current).toBe(true);
    expect(slotForGap(slots, 1, 3)?.after).toBe("s2");
  });

  it_("agrees with the engine's moveFeature on every slot of the corpus plate", async () => {
    const doc = (await engine.canonicalize(PLATE)).document;
    const list = features(doc);
    let checked = 0;
    for (const f of list) {
      for (const slot of moveSlots(list, f.id)) {
        if (slot.current) continue;
        let accepted: boolean;
        try {
          await applyOp(engine, doc, { op: "moveFeature", feature: f.id, after: slot.after });
          accepted = true;
        } catch (e) {
          if (!(e instanceof CommandEngineError) || e.code !== "COMMAND_ILLEGAL_ORDER") throw e;
          accepted = false;
        }
        expect({ feature: f.name, after: slot.after, accepted }).toEqual({ feature: f.name, after: slot.after, accepted: slot.valid });
        checked++;
      }
    }
    expect(checked).toBe(list.length * (list.length - 1));
  }, 120_000);
});

/**
 * Picked geometry on the real Forge engine: `refFor` (a Ref synthesized and verified by Forge from
 * render names and points), the insertion point, and `feasibleRange` of fillet, chamfer and shell
 * sizes — the queries the manual tools and the agent share before they commit `addFeature`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CommandEngineError, type IrCommandEngine } from "../src/engine.js";
import { MemoryOpsHost } from "../src/host.js";
import { feasibleRange, insertionPoint, refForPicks } from "../src/picks.js";
import { hasWasm, loadEngine, plate } from "./engine.js";

let engine: IrCommandEngine;
beforeAll(async () => {
  if (hasWasm) engine = await loadEngine();
}, 60_000);

const it_ = hasWasm ? it : it.skip;

const TOP_EDGE = "e1/edge:{e1/cap:end|e1/side:r.top}";

async function refusal(p: Promise<unknown>): Promise<CommandEngineError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CommandEngineError);
    return e as CommandEngineError;
  }
  throw new Error("expected a refusal");
}

describe("insertionPoint", () => {
  it("is the rollback marker in its part, else the part's last feature", () => {
    const d = plate();
    expect(insertionPoint(d, undefined, null)).toEqual({ part: "p1", after: "e1" });
    expect(insertionPoint(d, "p1", "s1")).toEqual({ part: "p1", after: "s1" });
    expect(insertionPoint(d, "part", "nope")).toEqual({ part: "p1", after: "e1" });
  });
});

describe("refForPicks", () => {
  it_("turns a picked edge into a captured Ref a fillet resolves to exactly it, through the same transaction as the agent's", async () => {
    const d = plate();
    const r = await refForPicks(engine, d, { kind: "edge", picks: [{ kind: "edge", name: TOP_EDGE, point: [0, 10, 5] }] }, { rollback: null });
    expect(r.members).toHaveLength(1);
    expect(r.ref.capture).toBeTruthy();
    for (const origin of ["user", "agent"] as const) {
      const host = await MemoryOpsHost.open({ engine, document: d, origin });
      const c = await host.apply([{ op: "addFeature", feature: { type: "fillet", r: 2, edges: r.ref } }]);
      expect(c.changed).toBe(true);
      const rep = await host.report();
      const f = rep.features.find((x) => x.type === "fillet")!;
      expect(f.status).toBe("ok");
      expect(f.refs![0]!.members.map((m) => m.key)).toEqual(r.members.map((m) => m.key));
    }
  });

  it_("takes a face's boundary edges for an edge Ref, and a body by its origin", async () => {
    const d = plate();
    const loop = await refForPicks(engine, d, { kind: "edge", picks: [{ kind: "face", name: "e1/cap:end" }] }, {});
    expect(loop.members).toHaveLength(4);
    const body = await refForPicks(engine, d, { kind: "body", picks: [{ kind: "body", body: { feature: "e1", member: "r.bottom" } }] }, {});
    expect(body.members.map((m) => m.key)).toEqual(["e1/body:r.bottom"]);
  });

  it_("resolves in an existing feature's input state when re-editing it", async () => {
    const d = plate({ features: [{ type: "fillet", id: "f1", name: "f1", r: 1, edges: { kind: "edge", q: { op: "edges", of: { op: "cap", feature: "e1", end: "end" } } } }] });
    // At the end of the part the cap's edges are gone (blended); in the fillet's input state they exist.
    const e = await refusal(refForPicks(engine, d, { kind: "edge", picks: [{ kind: "edge", name: TOP_EDGE }] }, {}));
    expect(e.code).toBe("COMMAND_PICK_NOT_FOUND");
    const r = await refForPicks(engine, d, { kind: "edge", picks: [{ kind: "edge", name: TOP_EDGE }] }, { feature: "f1" });
    expect(r.members).toHaveLength(1);
  });
});

describe("feasibleRange", () => {
  const edges = { kind: "edge", q: { op: "filter", where: { parallel: "Z" }, of: { op: "edges", of: { op: "sides", feature: "e1" } } } };

  it_("reports a fillet's largest radius (face width 20 → 9.999) for a candidate and an existing feature", async () => {
    const d = plate();
    const cand = await feasibleRange(engine, d, { candidate: { type: "fillet", r: 1, edges }, after: "e1" });
    expect(cand).toMatchObject({ field: "r", min: 0, minExclusive: true, max: 9.999 });
    expect(cand.reason).toMatch(/face width 20/);
    const withFillet = plate({ features: [{ type: "fillet", id: "f1", name: "f1", r: 1, edges }] });
    expect((await feasibleRange(engine, withFillet, { feature: "f1" })).max).toBe(9.999);
  });

  it_("reports a chamfer's largest distance and a shell's largest thickness", async () => {
    const d = plate();
    const ch = await feasibleRange(engine, d, { candidate: { type: "chamfer", d: 1, edges: { kind: "edge", q: { op: "edges", of: { op: "cap", feature: "e1", end: "end" } } } }, after: "e1" });
    expect(ch).toMatchObject({ field: "d", max: 4.999 });
    const sh = await feasibleRange(engine, d, {
      candidate: { type: "shell", thickness: 1, body: { kind: "body", q: { op: "body", feature: "e1" } }, open: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } },
      after: "e1",
    });
    expect(sh).toMatchObject({ field: "thickness", max: 4.999 });
  });

  it_("finds the largest radius that builds by bisection when a blend runs into another feature (a capability gap, not a size limit)", async () => {
    // A 40 × 20 × 10 block with a 4 × 4 pocket at x = 10 in its top: the fillet of the top front
    // edge (y = −10) reaches the pocket (y = −2) once r > 8.
    const d = plate({
      features: [
        { type: "sketch", id: "s2", name: "pocket_sketch", plane: { origin: [0, 0, 10], normal: [0, 0, 1], x_dir: [1, 0, 0] }, curves: [{ kind: "rect", id: "p", center: [10, 0], w: 4, h: 4 }] },
        { type: "extrude", id: "e2", name: "pocket", sketch: "s2", distance: 3, direction: "reverse", op: "cut", targets: "all" },
      ],
    }).replace('"value":5,"min":1', '"value":10,"min":1');
    const topFront = { kind: "edge", q: { op: "between", a: { op: "cap", feature: "e1", end: "end" }, b: { op: "side", feature: "e1", curve: "r.bottom" } } };
    const r = await feasibleRange(engine, d, { candidate: { type: "fillet", r: 1, edges: topFront }, after: "e2" });
    expect(r.max).toBeGreaterThan(7);
    expect(r.max).toBeLessThanOrEqual(8.001);
    expect(r.code).toBe("FILLET_FAILED");
    expect(r.reason).toMatch(/^above /);
    // The value it suggests builds.
    const host = await MemoryOpsHost.open({ engine, document: d, origin: "user" });
    await host.apply([{ op: "addFeature", feature: { type: "fillet", r: r.max!, edges: topFront } }]);
    const rep = await host.report();
    expect(rep.features.at(-1)?.status).toBe("ok");
  });

  it_("says so when a feature has no size field Forge bounds, and when it fails for another reason", async () => {
    const d = plate();
    const e = await refusal(feasibleRange(engine, d, { feature: "e1" }));
    expect(e.code).toBe("COMMAND_NO_FEASIBLE_RANGE");
    const broken = await feasibleRange(engine, d, { candidate: { type: "fillet", r: 1, edges: { kind: "edge", card: 2, q: { op: "edges", of: { op: "cap", feature: "e1", end: "start" } } } }, after: "e1" });
    expect(broken.code).toBe("REF_CARDINALITY");
    expect(broken.max).toBeUndefined();
  });
});

/**
 * Transactions on the real Forge engine: atomicity, the failure rule (the edited feature must
 * build; newly failing features need an exact acknowledgement), ADR 0015's commit check, the
 * automatic write-back, the queries, and the in-memory host's undo/redo.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { EMPTY_HOST_STATE, type OpOrigin } from "../src/apply.js";
import type { IrOp } from "../src/catalogue.js";
import { blankDocument, parseDoc } from "../src/doc.js";
import { CommandEngineError, type IrCommandEngine } from "../src/engine.js";
import { MemoryOpsHost } from "../src/host.js";
import { dependents, paramUses, rolledBack, rolledBackFeatures } from "../src/queries.js";
import { OpTransaction, runTransaction, type TransactionSettings } from "../src/transaction.js";
import { hasWasm, loadEngine, plate } from "./engine.js";

let engine: IrCommandEngine;
beforeAll(async () => {
  if (hasWasm) engine = await loadEngine();
}, 60_000);

const it_ = hasWasm ? it : it.skip;

async function canonical(text: string): Promise<string> {
  return (await engine.canonicalize(text)).document;
}

function settings(document: string, extra: Partial<TransactionSettings> = {}): TransactionSettings {
  return { engine, document, host: EMPTY_HOST_STATE, origin: "user", ...extra };
}

async function refused(p: Promise<unknown>): Promise<CommandEngineError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CommandEngineError);
    return e as CommandEngineError;
  }
  throw new Error("expected a refusal");
}

/** A detached square far from the plate: joining it fails with BOOLEAN_NO_INTERSECTION. */
const farSketch = { type: "sketch", id: "s2", name: "far", plane: "XY", curves: [{ kind: "rect", id: "q", center: [200, 200], w: 5, h: 5 }] };

describe("the failure rule", () => {
  it_("refuses a transaction whose new feature does not build (COMMAND_FEATURE_FAILS, with its code)", async () => {
    const base = await canonical(plate());
    const e = await refused(
      runTransaction(settings(base), [
        { op: "addFeature", feature: farSketch },
        { op: "addFeature", feature: { type: "extrude", sketch: "s2", distance: 3, op: "join", targets: "all" } },
      ]),
    );
    expect(e.code).toBe("COMMAND_FEATURE_FAILS");
    expect(e.details).toMatchObject({ feature: "extrude1", code: "BOOLEAN_NO_INTERSECTION" });
  });

  it_("refuses newly failing features unless exactly they are acknowledged", async () => {
    const base = await canonical(plate());
    const suppress: IrOp[] = [{ op: "setSuppressed", feature: "s1", suppressed: true }];
    const e = await refused(runTransaction(settings(base), suppress));
    expect(e.code).toBe("COMMAND_NEW_FAILURES");
    expect(e.details["features"]).toEqual([{ id: "e1", name: "slab", code: "SKETCH_SUPPRESSED", message: 'sketch "outline" is suppressed' }]);
    expect((await refused(runTransaction(settings(base, { ack: ["e1", "s1"] }), suppress))).code).toBe("COMMAND_NEW_FAILURES");
    const ok = await runTransaction(settings(base, { ack: ["e1"] }), suppress);
    expect(ok.changed).toBe(true);
    expect(ok.newFailures?.map((f) => f.id)).toEqual(["e1"]);
    // A parameter set that breaks a feature is the same rule.
    const t0 = await refused(runTransaction(settings(base), [{ op: "setParam", name: "t", value: "t_missing" }]));
    expect(t0.code).toBe("EXPR_UNKNOWN_NAME");
  });

  it_("is atomic: a refused op leaves nothing, even after ops that succeeded", async () => {
    const base = await canonical(plate());
    const tx = new OpTransaction(settings(base));
    await tx.apply({ op: "setField", feature: "e1", path: "/distance", value: 9 });
    await expect(tx.apply({ op: "deleteFeature", feature: "s1" })).rejects.toMatchObject({ code: "COMMAND_HAS_DEPENDENTS" });
    await tx.close();
    await expect(tx.finish()).rejects.toMatchObject({ code: "COMMAND_HAS_DEPENDENTS" });
    await expect(tx.apply({ op: "setParam", name: "t", value: 3 })).rejects.toMatchObject({ code: "IR_TRANSACTION_CLOSED" });
  });
});

describe("ADR 0015's commit check", () => {
  const byOrigin = (origin: OpOrigin, doc: string, ops: IrOp[], approvals?: { features?: string[]; params?: string[] }) =>
    runTransaction(settings(doc, { origin, ...(approvals ? { approvals } : {}) }), ops);

  it_("refuses an agent or MCP change to your feature or parameter without approval, and lets approved ones through", async () => {
    const base = await canonical(plate());
    for (const origin of ["agent", "mcp:claude", "cli"] as const) {
      const e = await refused(byOrigin(origin, base, [{ op: "setField", feature: "e1", path: "/distance", value: 8 }]));
      expect(e.code).toBe("unapproved_user_change");
      expect(e.details["features"]).toEqual([{ id: "e1", name: "slab", change: "changed" }]);
    }
    expect((await refused(byOrigin("agent", base, [{ op: "setParam", name: "t", value: 9 }]))).details["params"]).toEqual([{ name: "t", change: "changed" }]);
    const approved = await byOrigin("agent", base, [{ op: "setField", feature: "e1", path: "/distance", value: 8 }], { features: ["e1"] });
    expect(approved.changed).toBe(true);
    // Your own edits never need approval; agents may add new things and edit their own.
    expect((await byOrigin("user", base, [{ op: "setParam", name: "t", value: 9 }])).changed).toBe(true);
    const added = await byOrigin("agent", base, [
      { op: "addParam", name: "boss_h", unit: "mm", value: 4 },
      { op: "addFeature", feature: { type: "extrude", sketch: "s1", distance: "boss_h", op: "join", targets: "all" } },
    ]);
    const again = await byOrigin("agent", added.document, [{ op: "setField", feature: "extrude1", path: "/distance", value: 6 }]);
    expect(again.changed).toBe(true);
  });
});

describe("write-back", () => {
  it_("runs after the ops inside the transaction (a constrained sketch keeps its solved geometry)", async () => {
    const doc = await canonical(
      JSON.stringify({
        schema: "aicad.ir/1",
        meta: { name: "c" },
        params: [{ name: "w", unit: "mm", value: 30 }],
        parts: [
          {
            id: "p1",
            name: "part",
            features: [
              {
                type: "sketch",
                id: "s1",
                name: "sk",
                plane: "XY",
                curves: [
                  { kind: "line", id: "a", start: [0, 0], end: [30, 0] },
                  { kind: "line", id: "b", start: [30, 0], end: [30, 10] },
                  { kind: "line", id: "c", start: [30, 10], end: [0, 10] },
                  { kind: "line", id: "d", start: [0, 10], end: [0, 0] },
                ],
                constraints: [
                  { type: "coincident", id: "k1", a: "a.end", b: "b.start" },
                  { type: "coincident", id: "k2", a: "b.end", b: "c.start" },
                  { type: "coincident", id: "k3", a: "c.end", b: "d.start" },
                  { type: "coincident", id: "k4", a: "d.end", b: "a.start" },
                  { type: "horizontal", id: "h1", line: "a" },
                  { type: "horizontal", id: "h2", line: "c" },
                  { type: "vertical", id: "v1", line: "b" },
                  { type: "vertical", id: "v2", line: "d" },
                  { type: "fix", id: "f", entity: "a.start", x: 0, y: 0 },
                  { type: "distance", id: "dw", a: "a.start", b: "a.end", value: "w" },
                  { type: "distance", id: "dh", a: "b.start", b: "b.end", value: 10 },
                ],
              },
            ],
          },
        ],
      }),
    );
    const t = await runTransaction(settings(doc), [{ op: "setParam", name: "w", value: 50 }]);
    expect(t.ops.map((o) => o.op.op)).toEqual(["setParam", "writeBackSolution"]);
    const a = parseDoc(t.document).parts[0]!.features[0]!["curves"] as Array<{ end: number[] }>;
    expect(a[0]!.end[0]).toBeCloseTo(50, 9);
    expect(a[0]!.end[1]).toBeCloseTo(0, 9);
  });
});

describe("queries", () => {
  it_("dependents, parameter uses and the rollback cut", async () => {
    const base = await canonical(plate());
    expect((await dependents(engine, base, "outline")).dependents.map((d) => d.id)).toEqual(["e1"]);
    expect((await dependents(engine, base, "e1")).dependents).toEqual([]);
    expect((await paramUses(engine, base, "t")).uses.map((u) => u.path)).toEqual(["/parts/0/features/1/distance"]);
    expect(rolledBackFeatures(base, "s1")).toEqual(["e1"]);
    const cut = await engine.report(rolledBack(base, "s1"));
    expect(cut.features.map((f) => f.feature_id)).toEqual(["s1"]);
  });
});

describe("MemoryOpsHost", () => {
  it_("applies transactions as its origin, reports commits, and undoes/redoes them exactly", async () => {
    const host = await MemoryOpsHost.open({ engine, document: blankDocument("demo"), origin: "mcp:test" });
    const start = await host.document();
    const seen: string[] = [];
    host.onDidCommit((c) => seen.push(c.label));
    const c1 = await host.apply([{ op: "addFeature", feature: { type: "sketch", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 5 }] } }]);
    const c2 = await host.apply([{ op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 10 } }], { label: "Pin" });
    expect([c1.changed, c2.changed, c2.revision]).toEqual([true, true, 2]);
    expect(seen).toEqual(["Add sketch", "Pin"]);
    const after = await host.document();
    expect(parseDoc(after).parts[0]!.features.map((f) => [f.id, f["author"]])).toEqual([
      ["sketch1", "agent"],
      ["extrude1", "agent"],
    ]);
    const report = await host.report();
    expect(report.features[1]?.bodies?.[0]?.volume).toBeCloseTo(Math.PI * 25 * 10, 3);
    expect(host.undo()).toBe(true);
    expect(host.undo()).toBe(true);
    expect(await host.document()).toBe(start);
    expect(host.redo()).toBe(true);
    expect(host.redo()).toBe(true);
    expect(await host.document()).toBe(after);
    await expect(host.apply([{ op: "deleteFeature", feature: "sketch1" }])).rejects.toMatchObject({ code: "COMMAND_HAS_DEPENDENTS" });
    expect(await host.document()).toBe(after);
  });
});

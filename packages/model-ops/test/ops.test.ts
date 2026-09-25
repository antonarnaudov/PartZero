/**
 * The op catalogue v2 on the real Forge engine: every op applied, checked, and undone by its
 * semantic inverse to the identical canonical document; the refusals (dependents, illegal order,
 * parameters in use, authorship); the host-state ops.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { applyOp, EMPTY_HOST_STATE, type HostState, type OpOrigin, type OpOutcome } from "../src/apply.js";
import { IrOpSchema, OP_CATALOGUE, OP_SCHEMAS, opLabel, type IrOp } from "../src/catalogue.js";
import { parseDoc } from "../src/doc.js";
import { CommandEngineError, type IrCommandEngine } from "../src/engine.js";
import { hasWasm, loadEngine, plate } from "./engine.js";

let engine: IrCommandEngine;
beforeAll(async () => {
  if (hasWasm) engine = await loadEngine();
}, 60_000);

const it_ = hasWasm ? it : it.skip;

async function canonical(text: string): Promise<string> {
  return (await engine.canonicalize(text)).document;
}

async function apply(doc: string, op: IrOp, origin: OpOrigin = "user", host: HostState = EMPTY_HOST_STATE): Promise<OpOutcome> {
  return applyOp(engine, doc, IrOpSchema.parse(op), { origin, host });
}

/** Apply every inverse op in order (as the host, which may restore authorship). */
async function undoWith(doc: string, o: OpOutcome, host: HostState = EMPTY_HOST_STATE): Promise<{ document: string; host: HostState }> {
  expect(o.inverseOps, `${o.label} has a semantic inverse`).not.toBeNull();
  let d = doc;
  let h = o.host ?? host;
  for (const inv of o.inverseOps!) {
    const r = await applyOp(engine, d, inv, { origin: "command", host: h });
    d = r.document;
    if (r.host) h = r.host;
  }
  return { document: d, host: h };
}

async function refusal(p: Promise<unknown>): Promise<CommandEngineError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CommandEngineError);
    return e as CommandEngineError;
  }
  throw new Error("expected a refusal");
}

function features(doc: string): Array<{ id: string; name: string; type: string; author?: string }> {
  return parseDoc(doc).parts.flatMap((p) => p.features.map((f) => ({ id: f.id, name: f.name, type: f.type, ...(typeof f["author"] === "string" ? { author: f["author"] } : {}) })));
}

describe("the catalogue", () => {
  it("has one schema, one label and one entry per op", () => {
    const names = OP_CATALOGUE.map((o) => o.op).sort();
    expect(names).toEqual(Object.keys(OP_SCHEMAS).sort());
    for (const o of OP_CATALOGUE) expect(o.description.length).toBeGreaterThan(20);
    expect(new Set(OP_CATALOGUE.flatMap((o) => (o.tool ? [o.tool] : []))).size).toBe(OP_CATALOGUE.filter((o) => o.tool).length);
    expect(opLabel({ op: "addFeature", feature: { type: "extrude", name: "boss" } })).toBe("Add extrude boss");
  });
});

describe("addFeature", () => {
  it_("adds a sketch and an extrude with <type><n> ids, the user's authorship, and deleteFeature as its inverse", async () => {
    const base = await canonical(JSON.stringify({ schema: "aicad.ir/1", meta: { name: "x" }, parts: [{ id: "p1", name: "part", features: [] }] }));
    const s = await apply(base, { op: "addFeature", feature: { type: "sketch", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 30, h: 20 }] } });
    expect(s.changed).toBe(true);
    expect(s.result).toMatchObject({ feature: "sketch1", name: "sketch1", part: "p1", index: 0, author: "user" });
    const e = await apply(s.document, { op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 4 } });
    expect(features(e.document)).toEqual([
      { id: "sketch1", name: "sketch1", type: "sketch" },
      { id: "extrude1", name: "extrude1", type: "extrude" },
    ]);
    expect(e.touched.features).toEqual(["extrude1"]);
    expect(e.inverse).toEqual({ op: "deleteFeature", feature: "extrude1" });
    expect((await undoWith(e.document, e)).document).toBe(s.document);
    expect((await undoWith(s.document, s)).document).toBe(base);
    const report = await engine.report(e.document);
    expect(report.features.map((f) => [f.feature_id, f.status])).toEqual([
      ["sketch1", "ok"],
      ["extrude1", "ok"],
    ]);
  });

  it_("inserts after a feature, first with after: null, and refuses the IR rejection with its path", async () => {
    const base = await canonical(plate());
    const d = await apply(base, { op: "addFeature", after: "s1", feature: { type: "datum_plane", id: "d1", name: "mid", mode: "offset", from: "XY", distance: 10 } });
    expect(features(d.document).map((f) => f.id)).toEqual(["s1", "d1", "e1"]);
    const first = await apply(base, { op: "addFeature", after: null, feature: { type: "sketch", plane: "XZ", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 3 }] } });
    expect(features(first.document).map((f) => f.id)).toEqual(["sketch1", "s1", "e1"]);
    const bad = await refusal(apply(base, { op: "addFeature", feature: { type: "extrude", sketch: "nope", distance: 3 } }));
    expect(bad.code).toBe("UNRESOLVED_SKETCH");
    expect(bad.errors[0]!.path).toBe("/parts/0/features/2/sketch");
    const dup = await refusal(apply(base, { op: "addFeature", feature: { type: "extrude", id: "e1", sketch: "s1", distance: 3 } }));
    expect(dup.code).toBe("DUPLICATE_ID");
  });

  it_("goes at the rollback marker and moves the marker past it", async () => {
    const base = await canonical(plate());
    const host: HostState = { rollback: "s1", appearance: {} };
    const o = await apply(base, { op: "addFeature", feature: { type: "extrude", sketch: "s1", distance: 2, op: "new_body" } }, "user", host);
    expect(features(o.document).map((f) => f.id)).toEqual(["s1", "extrude1", "e1"]);
    expect(o.host?.rollback).toBe("extrude1");
    const back = await undoWith(o.document, o, host);
    expect(back.document).toBe(base);
    expect(back.host.rollback).toBe("s1");
  });
});

describe("setField and updateFeature", () => {
  it_("set a field (literal or expression), remove it, and undo to the same bytes", async () => {
    const base = await canonical(plate());
    const lit = await apply(base, { op: "setField", feature: "e1", path: "/distance", value: 12 });
    expect(parseDoc(lit.document).parts[0]!.features[1]!["distance"]).toBe(12);
    expect(lit.inverse).toEqual({ op: "setField", feature: "e1", path: "/distance", value: "t" });
    expect((await undoWith(lit.document, lit)).document).toBe(base);
    const expr = await apply(base, { op: "setField", feature: "e1", path: "/distance", value: { expr: "t*2" } });
    expect(parseDoc(expr.document).parts[0]!.features[1]!["distance"]).toBe("t * 2");
    const dir = await apply(base, { op: "setField", feature: "e1", path: "/direction", value: "symmetric" });
    expect(dir.inverse).toEqual({ op: "setField", feature: "e1", path: "/direction", remove: true });
    expect((await undoWith(dir.document, dir)).document).toBe(base);
    const curve = await apply(base, { op: "setField", feature: "s1", path: "/curves/0/w", value: 60 });
    const report = await engine.report(curve.document);
    expect(report.features.find((f) => f.feature_id === "e1")?.bodies?.[0]?.volume).toBeCloseTo(60 * 20 * 5, 6);
  });

  it_("refuse fixed fields, bad paths and values the IR rejects (at their path)", async () => {
    const base = await canonical(plate());
    expect((await refusal(apply(base, { op: "setField", feature: "e1", path: "/type", value: "revolve" }))).code).toBe("COMMAND_FIXED_FIELD");
    expect((await refusal(apply(base, { op: "setField", feature: "e1", path: "/nope/x", value: 1 }))).code).toBe("COMMAND_BAD_PATH");
    expect((await refusal(apply(base, { op: "setField", feature: "zz", path: "/distance", value: 1 }))).code).toBe("COMMAND_UNKNOWN_FEATURE");
    const unit = await refusal(apply(base, { op: "setField", feature: "e1", path: "/distance", value: { expr: "30 deg" } }));
    expect(unit.errors[0]!.path).toBe("/parts/0/features/1/distance");
  });

  it_("updateFeature merges top-level fields (null removes) and restores them", async () => {
    const base = await canonical(plate());
    const o = await apply(base, { op: "updateFeature", feature: "e1", set: { distance: 9, direction: "symmetric" } });
    const e1 = parseDoc(o.document).parts[0]!.features[1]!;
    expect([e1["distance"], e1["direction"]]).toEqual([9, "symmetric"]);
    expect(o.inverse).toEqual({ op: "updateFeature", feature: "e1", set: { distance: "t", direction: null } });
    expect((await undoWith(o.document, o)).document).toBe(base);
    expect((await refusal(apply(base, { op: "updateFeature", feature: "e1", set: { id: "x" } }))).code).toBe("COMMAND_FIXED_FIELD");
  });
});

describe("deleteFeature", () => {
  const withBoss = () => plate({ features: [{ type: "fillet", id: "f1", name: "round", edges: { kind: "edge", q: { op: "filter", of: { op: "edges", of: { op: "sides", feature: "e1" } }, where: { parallel: "Z" } } }, r: 1 }] });

  it_("refuses a feature with dependents and lists them, transitive ones included", async () => {
    const base = await canonical(withBoss());
    const r = await refusal(apply(base, { op: "deleteFeature", feature: "s1" }));
    expect(r.code).toBe("COMMAND_HAS_DEPENDENTS");
    const deps = (r.details["dependents"] as Array<{ id: string; code: string }>).map((d) => d.id);
    expect(deps).toEqual(["e1", "f1"]);
  });

  it_("cascades, and its inverse re-adds every deleted feature at its place (same bytes)", async () => {
    const base = await canonical(withBoss());
    const o = await apply(base, { op: "deleteFeature", feature: "s1", dependents: "cascade" }, "user", { rollback: "e1", appearance: { e1: "#ff0000" } });
    expect(features(o.document)).toEqual([]);
    expect(o.result).toMatchObject({ deleted: ["s1", "e1", "f1"] });
    expect(o.host).toEqual({ rollback: null, appearance: {} });
    expect(o.inverseOps?.map((x) => x.op)).toEqual(["addFeature", "addFeature", "addFeature"]);
    expect((await undoWith(o.document, o)).document).toBe(base);
  });

  it_("deletes a leaf feature and restores it", async () => {
    const base = await canonical(withBoss());
    const o = await apply(base, { op: "deleteFeature", feature: "round" });
    expect(features(o.document).map((f) => f.id)).toEqual(["s1", "e1"]);
    expect(o.inverse).toMatchObject({ op: "addFeature", part: "p1", after: "e1" });
    expect((await undoWith(o.document, o)).document).toBe(base);
  });
});

describe("moveFeature", () => {
  it_("reorders legally and back, and refuses a forward reference with COMMAND_ILLEGAL_ORDER", async () => {
    const base = await canonical(plate({ features: [{ type: "datum_plane", id: "d1", name: "mid", mode: "offset", from: "XY", distance: 10 }] }));
    const o = await apply(base, { op: "moveFeature", feature: "d1", after: null });
    expect(features(o.document).map((f) => f.id)).toEqual(["d1", "s1", "e1"]);
    expect(o.inverse).toEqual({ op: "moveFeature", feature: "d1", after: "e1" });
    expect((await undoWith(o.document, o)).document).toBe(base);
    const bad = await refusal(apply(base, { op: "moveFeature", feature: "e1", after: null }));
    expect(bad.code).toBe("COMMAND_ILLEGAL_ORDER");
    expect(bad.details["problems"]).toEqual([{ feature: "e1", name: "slab", code: "UNRESOLVED_SKETCH", path: "/sketch" }]);
    const same = await apply(base, { op: "moveFeature", feature: "e1", after: "s1" });
    expect(same.changed).toBe(false);
  });
});

describe("setSuppressed", () => {
  it_("suppresses and unsuppresses; the inverse restores the bytes", async () => {
    const base = await canonical(plate());
    const o = await apply(base, { op: "setSuppressed", feature: "e1", suppressed: true });
    expect(parseDoc(o.document).parts[0]!.features[1]!["suppressed"]).toBe(true);
    expect(o.touched.suppressed).toEqual(["e1"]);
    expect(o.inverse).toEqual({ op: "setSuppressed", feature: "e1", suppressed: false });
    expect((await undoWith(o.document, o)).document).toBe(base);
  });
});

describe("parameters", () => {
  it_("addParam adds (document or part level) and deleteParam is its inverse", async () => {
    const base = await canonical(plate());
    const o = await apply(base, { op: "addParam", name: "wall", unit: "mm", value: "t / 2", min: 0.5 });
    expect(parseDoc(o.document).params?.map((p) => p["name"])).toEqual(["t", "wall"]);
    expect(o.inverse).toEqual({ op: "deleteParam", name: "wall" });
    expect((await undoWith(o.document, o)).document).toBe(base);
    const part = await apply(base, { op: "addParam", name: "n", unit: "count", value: 4, part: "p1" });
    expect(parseDoc(part.document).parts[0]!.params?.[0]).toMatchObject({ name: "n", unit: "count", value: 4 });
    expect((await refusal(apply(base, { op: "addParam", name: "t", unit: "mm", value: 1 }))).code).toBe("DUPLICATE_NAME");
    expect((await refusal(apply(base, { op: "addParam", name: "slab", unit: "mm", value: 1 }))).code).toBe("DUPLICATE_NAME");
  });

  it_("deleteParam refuses a parameter in use and lists the uses; inline replaces each use with its value", async () => {
    const base = await canonical(plate({ params: [{ name: "w", unit: "mm", value: "t * 8" }] }));
    const r = await refusal(apply(base, { op: "deleteParam", name: "t" }));
    expect(r.code).toBe("COMMAND_PARAM_IN_USE");
    expect((r.details["uses"] as Array<{ path: string }>).map((u) => u.path)).toEqual(["/params/1/value", "/parts/0/features/1/distance"]);
    const o = await apply(base, { op: "deleteParam", name: "t", uses: "inline" });
    const d = parseDoc(o.document);
    expect(d.params?.map((p) => [p["name"], p["value"]])).toEqual([["w", "5 mm * 8"]]);
    expect(d.parts[0]!.features[1]!["distance"]).toBe(5);
    const before = await engine.report(base);
    const after = await engine.report(o.document);
    expect(after.features.map((f) => f.bodies?.[0]?.volume)).toEqual(before.features.map((f) => f.bodies?.[0]?.volume));
    expect((await undoWith(o.document, o)).document).toBe(base);
  });

  it_("renameParam rewrites every use; renaming back restores the bytes", async () => {
    const base = await canonical(plate({ params: [{ name: "w", unit: "mm", value: "t * 8 + t" }] }));
    const o = await apply(base, { op: "renameParam", old: "t", new: "thickness" });
    const d = parseDoc(o.document);
    expect(d.params?.map((p) => [p["name"], p["value"]])).toEqual([
      ["thickness", 5],
      ["w", "thickness * 8 + thickness"],
    ]);
    expect(d.parts[0]!.features[1]!["distance"]).toBe("thickness");
    expect((await undoWith(o.document, o)).document).toBe(base);
    expect((await refusal(apply(base, { op: "renameParam", old: "t", new: "w" }))).code).toBe("DUPLICATE_NAME");
  });
});

describe("host state and authorship", () => {
  it_("setRollback and setAppearance change the host state only, with inverses", async () => {
    const base = await canonical(plate());
    const r = await apply(base, { op: "setRollback", after: "outline" });
    expect(r.document).toBe(base);
    expect(r.host).toEqual({ rollback: "s1", appearance: {} });
    expect(r.inverse).toEqual({ op: "setRollback", after: null });
    const a = await apply(base, { op: "setAppearance", feature: "e1", color: "#3A7BD5" }, "user", r.host);
    expect(a.host).toEqual({ rollback: "s1", appearance: { e1: "#3a7bd5" } });
    const back = await undoWith(base, a, r.host);
    expect(back.host).toEqual({ rollback: "s1", appearance: {} });
    expect((await refusal(apply(base, { op: "setAppearance", feature: "nope", color: null }))).code).toBe("COMMAND_UNKNOWN_FEATURE");
  });

  it_("agent features are marked agent; agents cannot write authorship; your edit of an agent feature makes it yours", async () => {
    const base = await canonical(plate());
    const byAgent = await apply(base, { op: "addFeature", feature: { type: "extrude", sketch: "s1", distance: 2, op: "join", targets: "all" } }, "agent");
    expect(features(byAgent.document).find((f) => f.id === "extrude1")?.author).toBe("agent");
    const mcp = await apply(base, { op: "addFeature", feature: { type: "extrude", sketch: "s1", distance: 2, op: "join", targets: "all" } }, "mcp:cursor");
    expect(features(mcp.document).find((f) => f.id === "extrude1")?.author).toBe("agent");
    expect((await refusal(apply(base, { op: "addFeature", feature: { type: "extrude", sketch: "s1", distance: 2, author: "user" } }, "agent"))).code).toBe(
      "COMMAND_AUTHOR_HOST_ONLY",
    );
    expect((await refusal(apply(base, { op: "setField", feature: "e1", path: "/author", value: "agent" }, "agent"))).code).toBe("COMMAND_AUTHOR_HOST_ONLY");
    expect((await refusal(apply(base, { op: "setAuthor", features: ["e1"], author: "agent" }, "mcp:x"))).code).toBe("COMMAND_AUTHOR_HOST_ONLY");
    const mine = await apply(byAgent.document, { op: "setField", feature: "extrude1", path: "/distance", value: 3 }, "user");
    expect(features(mine.document).find((f) => f.id === "extrude1")?.author).toBe("user");
    const renamed = await apply(byAgent.document, { op: "renameFeature", feature: "extrude1", name: "boss" }, "user");
    expect(features(renamed.document).find((f) => f.id === "extrude1")).toMatchObject({ name: "boss", author: "user" });
    const kept = await apply(byAgent.document, { op: "setAuthor", features: ["extrude1"], author: "user" }, "user");
    expect(features(kept.document).find((f) => f.id === "extrude1")?.author).toBe("user");
    expect((await undoWith(kept.document, kept)).document).toBe(byAgent.document);
  });
});

describe("replaceDocument (a code edit)", () => {
  it_("replaces the model, keeps authorship (code cannot write it), reports what changed, and undoes to the same bytes", async () => {
    const base = await canonical(plate({ features: [{ type: "extrude", id: "e2", name: "boss", sketch: "s1", distance: 2, op: "join", targets: "all", author: "agent" }] }));
    const next = JSON.parse(base) as { params: Array<{ value: unknown }>; parts: Array<{ features: Array<Record<string, unknown>> }> };
    next.params[0]!.value = 9;
    next.parts[0]!.features[2]!["distance"] = 3;
    next.parts[0]!.features[2]!["author"] = "user"; // ignored: the host writes authorship
    next.parts[0]!.features.push({ type: "extrude", id: "e3", name: "more", sketch: "s1", distance: 1, op: "join", targets: "all" });
    const byAgent = await apply(base, { op: "replaceDocument", document: JSON.stringify(next) }, "agent");
    expect(byAgent.touched).toMatchObject({ features: ["e2", "e3"], params: ["t"] });
    expect(features(byAgent.document).map((f) => [f.id, f.author ?? null])).toEqual([
      ["s1", null],
      ["e1", null],
      ["e2", "agent"],
      ["e3", "agent"],
    ]);
    expect(byAgent.inverse).toEqual({ op: "replaceDocument", document: base, keepAuthors: true });
    expect((await undoWith(byAgent.document, byAgent)).document).toBe(base);
    // The user's code edit of an agent feature makes it theirs.
    const byUser = await apply(base, { op: "replaceDocument", document: JSON.stringify(next) }, "user");
    expect(features(byUser.document).find((f) => f.id === "e2")?.author).toBe("user");
    // A v0 document is migrated; an invalid one is the engine's rejection.
    expect((await refusal(apply(base, { op: "replaceDocument", document: '{"schema":"aicad.ir/1","parts":[{"id":"p1","name":"part","features":[{"type":"extrude","id":"x","name":"x","sketch":"nope","distance":1}]}]}' }))).code).toBe(
      "UNRESOLVED_SKETCH",
    );
  });
});

describe("Phase C ops keep their inverses", () => {
  it_("setParam, renameFeature and renameCurve", async () => {
    const base = await canonical(plate());
    const p = await apply(base, { op: "setParam", name: "t", value: 7 });
    expect(p.inverse).toEqual({ op: "setParam", name: "t", value: 5 });
    expect((await undoWith(p.document, p)).document).toBe(base);
    const n = await apply(base, { op: "renameFeature", feature: "e1", name: "plate" });
    expect((await undoWith(n.document, n)).document).toBe(base);
  });
});

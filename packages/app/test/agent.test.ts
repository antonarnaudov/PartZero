import { applyIrEdit, compile } from "@aicad/cadscript";
import type { IrDocument } from "@aicad/ir-types";
import { describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/agent-protocol";
import { reduceRun, PREVIEW_TINT } from "../src/agent/agent-service";
import { approvalsFor, buildVariant, checkVariant, diffProposal } from "../src/agent/proposal";
import { describeFace, describeSelection } from "../src/agent/selection";
import { BOX, HEADER, makeHarness } from "./helpers";

const ir = (source: string, base?: IrDocument | null): IrDocument => {
  const r = compile(source, { base: base ?? undefined });
  if (!r.ok || !r.ir) throw new Error(`does not compile: ${r.diagnostics.map((d) => d.message).join("; ")}`);
  return r.ir;
};

/** BOX, plus a boss (new sketch + extrude), with the plate 7 mm instead of 5. */
const PROPOSED = BOX.replace("distance: 5", "distance: 7").concat(`const boss_sk = sketch(XY, {
  rim: circle({ center: [0, 0], radius: 6 }),
});
const boss = extrude(boss_sk, { distance: 12 });
`);

describe("proposal: per-feature diff, variants and dependency warnings", () => {
  const base = ir(BOX);
  const proposed = ir(PROPOSED, base);
  const changes = diffProposal(base, proposed);

  it("lists added/modified features with summaries and what they build on", () => {
    expect(changes.map((c) => [c.key, c.kind, c.summary, c.requires])).toEqual([
      ["plate/plate", "modified", "distance 5 → 7 mm", []],
      ["plate/boss_sk", "added", "new sketch on XY, 1 curve", []],
      ["plate/boss", "added", "new extrude of `boss_sk`, 12 mm", ["plate/boss_sk"]],
    ]);
  });

  it("builds the variant of an accepted subset and splices it into the source", () => {
    const v = buildVariant(base, proposed, base, new Set(["plate/plate"]), changes);
    expect(v.conflicts).toEqual([]);
    expect(checkVariant(v.ir, changes, new Set(["plate/plate"]))).toEqual([]);
    const source = applyIrEdit(BOX, base, v.ir);
    expect(source).toContain("const plate = extrude(outline, { distance: 7 });");
    expect(source).not.toContain("boss");
    expect(source).toContain("// The outline."); // untouched text and comments survive
    expect(ir(source).parts[0]!.features.map((f) => f.name)).toEqual(["outline", "plate"]);
  });

  it("rejecting a sketch that an accepted extrude uses is an error, and names the fix", () => {
    const keys = new Set(["plate/plate", "plate/boss"]);
    const v = buildVariant(base, proposed, base, keys, changes);
    expect(checkVariant(v.ir, changes, keys)).toEqual([
      { severity: "error", key: "plate/boss_sk", message: "`boss` uses sketch `boss_sk`, which you rejected. Accept `boss_sk` too, or reject `boss`." },
    ]);
    // Accepting both keeps the order of the proposal.
    const all = buildVariant(base, proposed, base, new Set(["plate/boss_sk", "plate/boss"]), changes);
    expect(all.ir.parts[0]!.features.map((f) => f.name)).toEqual(["outline", "plate", "boss_sk", "boss"]);
    expect(checkVariant(all.ir, changes, new Set(["plate/boss_sk", "plate/boss"]))).toEqual([]);
  });

  it("accepting the removal of a sketch that a kept feature uses is an error", () => {
    const removed = ir(`${HEADER}\npart("plate");\n`, base);
    const ch = diffProposal(base, removed);
    expect(ch.map((c) => `${c.kind}:${c.key}`)).toEqual(["removed:plate/outline", "removed:plate/plate"]);
    const keys = new Set(["plate/outline"]);
    const v = buildVariant(base, removed, base, keys, ch);
    expect(checkVariant(v.ir, ch, keys)).toEqual([
      { severity: "error", key: "plate/outline", message: "Removing `outline` breaks `plate`, which still uses it. Keep `outline`, or remove `plate` too." },
    ]);
  });

  it("warns when a change is accepted without the sketch change it was made with", () => {
    const both = ir(BOX.replace("distance: 5", "distance: 7").replace("[25, -25]),\n  right", "[26, -25]),\n  right").replace("right: line([25, -25]", "right: line([26, -25]"), base);
    const ch = diffProposal(base, both);
    expect(ch.map((c) => [c.key, c.summary])).toEqual([
      ["plate/outline", "curves ~bottom, right"],
      ["plate/plate", "distance 5 → 7 mm"],
    ]);
    const keys = new Set(["plate/plate"]);
    const w = checkVariant(buildVariant(base, both, base, keys, ch).ir, ch, keys);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: "warning", key: "plate/outline" });
  });

  it("reports conflicts with edits made to the document during the run", () => {
    const edited = ir(BOX.replace("distance: 5", "distance: 6"), base);
    const v = buildVariant(base, proposed, edited, new Set(["plate/plate", "plate/boss_sk", "plate/boss"]), changes);
    expect(v.conflicts).toEqual(["`plate` was edited since the run started"]);
    // The additions still merge onto the user's version.
    expect(v.ir.parts[0]!.features.map((f) => f.name)).toEqual(["outline", "plate", "boss_sk", "boss"]);
    expect((v.ir.parts[0]!.features[1] as { distance: number }).distance).toBe(6);
  });
});

describe("proposal on an IR v1 model: parameters and what an accept approves", () => {
  /** An IR v1 model as the agent's proposals come back (ids = the const names): parameter `t` and your plate. */
  const v1 = (t: number, extra: { params?: unknown[]; features?: unknown[] } = {}): IrDocument =>
    ({
      schema: "aicad.ir/1",
      params: [{ name: "t", unit: "mm", value: t }, ...(extra.params ?? [])],
      parts: [
        {
          id: "p1",
          name: "part",
          features: [
            { type: "sketch", id: "outline", name: "outline", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 40, h: 20 }] },
            { type: "extrude", id: "slab", name: "slab", sketch: "outline", distance: "t" },
            ...(extra.features ?? []),
          ],
        },
      ],
    }) as unknown as IrDocument;
  const base = v1(5);
  const proposed = v1(6, {
    params: [{ name: "boss_h", unit: "mm", value: 3 }],
    features: [
      { type: "sketch", id: "boss_sk", name: "boss_sk", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 4 }] },
      { type: "extrude", id: "boss", name: "boss", sketch: "boss_sk", distance: "boss_h", op: "join", targets: "all" },
    ],
  });
  const changes = diffProposal(base, proposed);

  it("lists parameter changes, and the features that use a new parameter build on it", () => {
    expect(changes.map((c) => [c.key, c.kind, c.type, c.summary, c.requires])).toEqual([
      ["param:t", "modified", "parameter", "5 mm → 6 mm", []],
      ["param:boss_h", "added", "parameter", "new parameter = 3 mm", []],
      ["part/boss_sk", "added", "sketch", "new sketch on XY, 1 curve", []],
      ["part/boss", "added", "extrude", "new extrude of `boss_sk`, boss_h", ["param:boss_h", "part/boss_sk"]],
    ]);
  });

  it("carries accepted parameter changes into the variant; rejecting a parameter an accepted feature uses is an error", () => {
    const v = buildVariant(base, proposed, base, new Set(["param:boss_h", "part/boss_sk", "part/boss"]), changes);
    expect(v.conflicts).toEqual([]);
    const params = (v.ir as unknown as { params: Array<{ name: string; value: number }> }).params;
    expect(params.map((p) => [p.name, p.value])).toEqual([
      ["t", 5],
      ["boss_h", 3],
    ]);
    const without = new Set(["part/boss_sk", "part/boss"]);
    const w = checkVariant(buildVariant(base, proposed, base, without, changes).ir, changes, without);
    expect(w).toEqual([{ severity: "error", key: "param:boss_h", message: "`boss` uses parameter `boss_h`, which you rejected. Accept `boss_h` too, or reject `boss`." }]);
    // A parameter you changed since the run started conflicts.
    expect(buildVariant(base, proposed, v1(8), new Set(["param:t"]), changes).conflicts).toEqual(["parameter `t` was edited since the run started"]);
  });

  it("approves exactly the features and parameters the accepted changes modify or remove", () => {
    expect(approvalsFor(base, changes, new Set(changes.map((c) => c.key)))).toEqual({ features: [], params: ["t"] });
    expect(approvalsFor(base, changes, new Set(["param:boss_h", "part/boss_sk", "part/boss"]))).toEqual({ features: [], params: [] });
    const thicker = v1(5, {});
    (thicker.parts[0]!.features[1] as unknown as { distance: unknown }).distance = 7;
    const ch = diffProposal(base, thicker);
    expect(ch.map((c) => c.key)).toEqual(["part/slab"]);
    expect(approvalsFor(base, ch, new Set(["part/slab"]))).toEqual({ features: ["slab"], params: [] });
    expect(approvalsFor(base, ch, new Set())).toEqual({ features: [], params: [] });
  });
});

describe("selection → semantic context", () => {
  const base = ir(BOX);
  it("explains faces by the feature and sketch curve that made them", () => {
    expect(describeFace("plate/cap:end", base)).toBe("the end cap (the face at the far end of the extrusion) of extrude `plate` of sketch `outline`, 5 mm, in part `plate`");
    expect(describeFace("plate/side:top", base)).toBe("the side face swept from curve `top` of sketch `outline` by extrude `plate` of sketch `outline`, 5 mm, in part `plate`");
    const items = describeSelection(
      [
        { kind: "feature", ref: base.parts[0]!.features[1]!.id, label: "plate" },
        { kind: "edge", ref: "plate/edge:{plate/cap:end|plate/side:top}", label: "plate/edge:{plate/cap:end|plate/side:top}" },
      ],
      base,
    );
    expect(items[0]!.description).toBe("extrude `plate` of sketch `outline`, 5 mm, in part `plate`");
    expect(items[1]!.description).toMatch(/^the edge between the end cap .* and the side face swept from curve `top`/);
  });
});

describe("run reducer", () => {
  it("tracks phases, cost, questions and ignores duplicates", () => {
    const base = { v: 1 as const, runId: "r", t: 0 };
    let run = reduceRun(
      { runId: "r", prompt: "p", chips: [], status: "running", phase: null, phases: [], detail: "", activity: [], spentUsd: 0, budgetUsd: 0, elapsedMs: 0, models: {}, transport: null, engine: "", draft: null, question: null, result: null, error: null, lastSeq: 0 },
      { ...base, seq: 1, type: "phase", phase: "TRIAGE", detail: "" },
    );
    run = reduceRun(run, { ...base, seq: 2, t: 900, type: "cost", spentUsd: 0.02, budgetUsd: 1 });
    run = reduceRun(run, { ...base, seq: 3, type: "phase", phase: "BUILD", detail: "quick_edit" });
    run = reduceRun(run, { ...base, seq: 4, type: "question", questionId: "q1", kind: "clarify", questions: [{ id: "q1", question: "?", default: "a" }] });
    expect(run).toMatchObject({ phases: ["TRIAGE", "BUILD"], spentUsd: 0.02, budgetUsd: 1, status: "question", elapsedMs: 900 });
    expect(reduceRun(run, { ...base, seq: 4, type: "phase", phase: "DONE", detail: "" })).toBe(run);
    run = reduceRun(run, { ...base, seq: 5, type: "answered", questionId: "q1", answers: ["a"] });
    expect(run.status).toBe("running");
    run = reduceRun(run, { ...base, seq: 6, type: "error", code: "WORKER_EXITED", message: "boom" });
    expect(run).toMatchObject({ status: "failed", error: { code: "WORKER_EXITED" } });
  });
});

function result(baseSource: string, proposedSource: string, extra: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    status: "proposed",
    stopReason: "proposed",
    message: "done",
    baseSource,
    proposedSource,
    changed: baseSource !== proposedSource,
    verified: true,
    summary: "Thicker plate and a boss.",
    assumptions: ["boss Ø12"],
    knownIssues: [],
    costUsd: 0.12,
    budgetUsd: 1,
    latencyMs: 4000,
    turns: 3,
    ...extra,
  };
}

describe("agent commands (fake desktop bridge)", () => {
  it("agent.run sends the document and the selection as semantic context", async () => {
    const h = await makeHarness({ source: BOX, agent: true });
    await h.commands.execute({ id: "selection.selectEntity", args: { body: "plate/plate", face: "plate/cap:end" } });
    const r = await h.commands.execute({ id: "chat.send", args: { text: "make this 2 mm thicker" } });
    expect(r).toEqual({ ok: true, value: { delivered: true, runId: "run-1" } });
    const req = h.agentBridge!.starts[0]!;
    expect(req).toMatchObject({ v: 1, prompt: "make this 2 mm thicker", source: BOX, documentName: "test" });
    expect(req.selection.map((s) => [s.kind, s.label])).toEqual([
      ["feature", "plate"],
      ["face", "plate/cap:end"],
    ]);
    expect(req.selection[1]!.description).toMatch(/^the end cap .* of extrude `plate`/);
    const chat = h.services.ui.getState().chat;
    expect(chat.at(-1)).toMatchObject({ role: "agent", runId: "run-1" });
    // One run at a time.
    expect(await h.commands.execute({ id: "agent.run", args: { prompt: "again" } })).toMatchObject({ ok: false, error: { code: "FAILED", message: expect.stringMatching(/already working/) } });
    expect((await h.commands.execute({ id: "agent.stop" })).ok).toBe(true);
    expect(h.agentBridge!.stops).toEqual([{ v: 1, runId: "run-1" }]);
  });

  it("a refused start (no key) explains how to fix it", async () => {
    const h = await makeHarness({ source: BOX, agent: true });
    h.agentBridge!.nextStart = { ok: false, code: "NO_API_KEY", message: "No API key for Anthropic (designer: Claude Opus 5.5)." };
    const r = await h.commands.execute({ id: "agent.run", args: { prompt: "thicker" } });
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringMatching(/No API key/) } });
    expect(h.services.ui.getState().chat.at(-1)).toMatchObject({ role: "system", tone: "error", action: { command: "settings.open" } });
    expect(h.services.agent.getState().activeRunId).toBeNull();
  });

  it("streams progress, answers questions, reviews the proposal and accepts it as ONE undoable transaction", async () => {
    const h = await makeHarness({ source: BOX, agent: true });
    const { agent } = h.services;
    await h.commands.execute({ id: "agent.run", args: { prompt: "thicker plate and a boss" } });
    const bridge = h.agentBridge!;
    bridge.emit("run-1", { type: "started", models: {}, budgetUsd: 1, transport: "scripted", engine: "fake" });
    bridge.emit("run-1", { type: "phase", phase: "TRIAGE", detail: "" });
    bridge.emit("run-1", { type: "cost", spentUsd: 0.01, budgetUsd: 1 });
    bridge.emit("run-1", { type: "question", questionId: "q1", kind: "clarify", questions: [{ id: "q1", question: "Boss size?", options: ["Ø12", "Ø16"], default: "Ø12" }] });
    expect(agent.activeRun).toMatchObject({ status: "question", spentUsd: 0.01 });
    expect(await h.commands.execute({ id: "agent.answer", args: { answers: [""] } })).toMatchObject({ ok: true });
    expect(bridge.answers[0]).toEqual({ v: 1, runId: "run-1", questionId: "q1", answers: ["Ø12"] });
    bridge.emit("run-1", { type: "answered", questionId: "q1", answers: ["Ø12"] });

    // A live draft opens the proposal tab.
    bridge.emit("run-1", { type: "draft", source: PROPOSED, applyIndex: 1, verified: true, reason: "apply" });
    expect(agent.getState()).toMatchObject({ codeTab: "proposal", review: { status: "draft", variantSource: PROPOSED } });
    expect(await h.commands.execute({ id: "agent.accept", args: {} })).toMatchObject({ ok: false, error: { code: "DISABLED" } });

    bridge.emit("run-1", { type: "result", result: result(BOX, PROPOSED) });
    const ready = await agent.waitFor((s) => s.review?.status === "ready" && s.review.preview.status === "ready");
    expect(ready.review!.changes.map((c) => c.key)).toEqual(["plate/plate", "plate/boss_sk", "plate/boss"]);
    expect(ready.review!.previewEnabled).toBe(true);
    expect(ready.review!.preview.bodies.every((b) => b.color === PREVIEW_TINT)).toBe(true);
    expect(ready.activeRunId).toBeNull();
    // The document is untouched until accepted.
    expect(h.services.doc.getState().source).toBe(BOX);

    const acc = await h.commands.execute({ id: "agent.accept", args: {} });
    expect(acc).toMatchObject({ ok: true, value: { applied: 3, total: 3, changed: true } });
    const s = await h.services.doc.idle();
    expect(s.source).toBe(PROPOSED);
    expect(s.history.undoLabel).toBe("Agent: thicker plate and a boss");
    expect(agent.getState()).toMatchObject({ codeTab: "code", review: { resolution: { kind: "accepted" }, previewEnabled: false } });
    expect(await h.commands.execute({ id: "agent.reject" })).toMatchObject({ ok: false, error: { code: "DISABLED" } });

    // One undo step reverts the whole agent change.
    await h.commands.execute({ id: "edit.undo" });
    expect((await h.services.doc.idle()).source).toBe(BOX);
    expect(h.services.doc.getState().history.canUndo).toBe(false);
  });

  it("per-feature accept: dependency errors refuse unless forced; the accepted subset is one transaction", async () => {
    const h = await makeHarness({ source: BOX, agent: true });
    const { agent } = h.services;
    await h.commands.execute({ id: "agent.run", args: { prompt: "thicker plate and a boss" } });
    h.agentBridge!.emit("run-1", { type: "result", result: result(BOX, PROPOSED) });
    await agent.waitFor((s) => s.review?.status === "ready");

    // Untick the boss sketch but keep the boss: the diff and warnings update, accepting refuses.
    const tick = await h.commands.execute({ id: "agent.setAccepted", args: { features: ["plate", "boss"] } });
    expect(tick).toMatchObject({ ok: true, value: { accepted: ["plate/plate", "plate/boss"] } });
    expect(agent.getState().review!.warnings.map((w) => w.severity)).toEqual(["error"]);
    const refused = await h.commands.execute({ id: "agent.acceptFeatures", args: { features: ["plate", "boss"] } });
    expect(refused).toMatchObject({ ok: false, error: { message: expect.stringMatching(/breaks the model: `boss` uses sketch `boss_sk`, which you rejected/) } });
    expect(h.services.doc.getState().source).toBe(BOX);

    // Only the plate: no warnings, the variant is spliced into the source.
    await h.commands.execute({ id: "agent.setAccepted", args: { features: ["plate"] } });
    expect(agent.getState().review!.variantSource).toContain("distance: 7 });");
    expect(agent.getState().review!.variantSource).not.toContain("boss");
    const ok = await h.commands.execute({ id: "agent.acceptFeatures", args: { features: ["plate"] } });
    expect(ok).toMatchObject({ ok: true, value: { applied: 1, total: 3 } });
    const s = await h.services.doc.idle();
    expect(s.source).toContain("const plate = extrude(outline, { distance: 7 });");
    expect(s.source).not.toContain("boss");
    expect(agent.getState().review!.resolution).toEqual({ kind: "partial", applied: 1, total: 3 });
    await h.commands.execute({ id: "edit.undo" });
    expect((await h.services.doc.idle()).source).toBe(BOX);
  });

  it("accepting after the user edited the document rebases onto the edits (and reports conflicts)", async () => {
    const h = await makeHarness({ source: BOX, agent: true });
    await h.commands.execute({ id: "agent.run", args: { prompt: "boss" } });
    h.agentBridge!.emit("run-1", { type: "result", result: result(BOX, PROPOSED) });
    await h.services.agent.waitFor((s) => s.review?.status === "ready");
    // The user changes the plate while the proposal waits.
    await h.commands.execute({ id: "doc.setSource", args: { source: BOX.replace("distance: 5", "distance: 6") } });
    await h.services.doc.idle();
    const conflict = await h.commands.execute({ id: "agent.accept", args: {} });
    expect(conflict).toMatchObject({ ok: false, error: { message: expect.stringMatching(/`plate` was edited since the run started/) } });
    const merged = await h.commands.execute({ id: "agent.acceptFeatures", args: { features: ["boss_sk", "boss"] } });
    expect(merged.ok).toBe(true);
    const s = await h.services.doc.idle();
    expect(s.source).toContain("distance: 6");
    expect(s.source).toContain("const boss = extrude(boss_sk, { distance: 12 });");
  });

  it("reject leaves the document unchanged; an answered question shows as an assistant message", async () => {
    const h = await makeHarness({ source: BOX, agent: true });
    await h.commands.execute({ id: "agent.run", args: { prompt: "thicker" } });
    h.agentBridge!.emit("run-1", { type: "result", result: result(BOX, PROPOSED) });
    await h.services.agent.waitFor((s) => s.review?.status === "ready");
    expect(await h.commands.execute({ id: "agent.run", args: { prompt: "another" } })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/waiting for review/) } });
    expect(await h.commands.execute({ id: "agent.reject" })).toEqual({ ok: true, value: { rejected: true } });
    expect(h.services.doc.getState().source).toBe(BOX);
    expect(h.services.doc.getState().history.canUndo).toBe(false);

    await h.commands.execute({ id: "agent.run", args: { prompt: "how thick is it?" } });
    h.agentBridge!.emit("run-2", { type: "result", result: result(BOX, BOX, { status: "answered", stopReason: "answered", answer: "5 mm." }) });
    expect(h.services.ui.getState().chat.at(-1)).toMatchObject({ role: "assistant", text: "5 mm." });
    expect(h.services.agent.getState().review!.resolution).toMatchObject({ kind: "rejected" });
  });

  it("settings commands: keys go to the bridge but never into execution records or results", async () => {
    const h = await makeHarness({ agent: true });
    const records: unknown[] = [];
    h.commands.onDidExecute((r) => records.push(r));
    const key = "sk-ant-test-0123456789abcdef";
    const r = await h.commands.execute({ id: "settings.setApiKey", args: { provider: "anthropic", key } });
    expect(r).toEqual({ ok: true, value: { provider: "anthropic", configured: true, last4: "cdef" } });
    expect(h.settingsBridge!.received).toEqual([{ provider: "anthropic", key }]);
    expect(JSON.stringify(records)).not.toContain(key);
    expect(JSON.stringify(h.services.agent.getState())).not.toContain(key);
    const bad = await h.commands.executeUnknown({ id: "settings.setApiKey", args: { provider: "anthropic", key: "short" } });
    expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(JSON.stringify(records)).not.toContain("short");

    expect(await h.commands.execute({ id: "settings.setModel", args: { role: "designer", model: "gpt-6-sol" } })).toMatchObject({ ok: true, value: { model: "gpt-6-sol" } });
    expect(await h.commands.execute({ id: "settings.setBudget", args: { usd: 2.5 } })).toEqual({ ok: true, value: { budgetUsd: 2.5 } });
    expect(await h.commands.execute({ id: "settings.clearApiKey", args: { provider: "anthropic" } })).toEqual({ ok: true, value: { provider: "anthropic", configured: false, source: null } });
    expect(await h.commands.execute({ id: "settings.open" })).toEqual({ ok: true, value: { open: true } });
    expect(h.services.ui.getState().dialog).toBe("settings");
  });
});

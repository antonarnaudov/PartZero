import { describe, expect, it, vi } from "vitest";
import { createShellCommandRegistry } from "../src/tools/commands";
import { staticSelectionPort } from "../src/tools/framework/ports";
import type { NumberValue, PanelSpec, PreviewOutcome, ToolDefinition } from "../src/tools/framework/types";
import { TOOL_GROUPS } from "../src/tools/framework/types";
import { ToolRegistry, ToolRegistryError } from "../src/tools/registry";
import { attachShell, isBlankDocument, Shell, shellOf } from "../src/tools/shell";
import { BLANK_SOURCE } from "../src/host/templates";
import { BOX, makeHarness } from "./helpers";

const tool = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  id: "feature.fillet",
  label: "Fillet",
  group: "modify",
  icon: "fillet",
  activate: () => undefined,
  ...over,
});

describe("the tool registry", () => {
  it("validates definitions and refuses duplicates", () => {
    const r = new ToolRegistry();
    expect(() => r.register(tool({ id: "Fillet" }))).toThrow(ToolRegistryError);
    expect(() => r.register(tool({ group: "misc" as never }))).toThrow(/unknown group/);
    expect(() => r.register(tool({ shortcut: "Shift F" }))).toThrow(/shortcut/);
    r.register(tool());
    expect(() => r.register(tool())).toThrow(/already registered/);
  });

  it("orders tools by group, then order, then label, and unregisters", () => {
    const r = new ToolRegistry();
    r.register(tool({ id: "inspect.measure", label: "Measure", group: "inspect" }));
    const off = r.register(tool({ id: "feature.chamfer", label: "Chamfer", group: "modify", order: 20 }));
    r.register(tool({ id: "feature.fillet", label: "Fillet", group: "modify", order: 10 }));
    r.register(tool({ id: "sketch.line", label: "Line", group: "sketch", modes: ["sketch"] }));
    r.register(tool({ id: "feature.extrude", label: "Extrude", group: "create" }));
    expect(r.list().map((t) => t.id)).toEqual(["sketch.line", "feature.extrude", "feature.fillet", "feature.chamfer", "inspect.measure"]);
    off();
    expect(r.byGroup("modify").map((t) => t.id)).toEqual(["feature.fillet"]);
  });

  it("maps shortcuts per mode (toolbar order wins a clash), lets app commands keep their keys, and reports clashes", () => {
    const r = new ToolRegistry();
    r.reserveKeys(new Map([["f", "view.fit"]]));
    r.register(tool({ id: "feature.fillet", shortcut: "Shift+F" }));
    r.register(tool({ id: "feature.fit", label: "Fit", shortcut: "F" }));
    r.register(tool({ id: "sketch.line", label: "Line", group: "sketch", shortcut: "L", modes: ["sketch"] }));
    r.register(tool({ id: "feature.loft", label: "Loft", group: "create", shortcut: "shift+f" }));
    // Deterministic whatever order the modules register in: the earlier toolbar group keeps the key.
    expect([...r.keymap("model")]).toEqual([["shift+f", "feature.loft"]]);
    expect([...r.keymap("sketch")]).toEqual([["l", "sketch.line"]]);
    const w = r.getState().warnings;
    expect(w.some((x) => x.includes("view.fit"))).toBe(true);
    expect(w.some((x) => x.includes("Fillet") && x.includes("feature.loft"))).toBe(true);
  });
});

describe("build flags", () => {
  it("hide a flagged tool (and its shortcut) until its flag is on", () => {
    const on = new Set<string>();
    const r = new ToolRegistry({ flags: (f) => on.has(f) });
    r.register(tool({ id: "feature.fillet", shortcut: "Shift+F", flag: "fillet" }));
    r.register(tool({ id: "feature.chamfer", label: "Chamfer" }));
    expect(r.list().map((t) => t.id)).toEqual(["feature.chamfer"]);
    expect(r.get("feature.fillet")).toBeUndefined();
    expect(r.isHidden("feature.fillet")).toBe(true);
    expect(r.keymap("model").has("shift+f")).toBe(false);
    on.add("fillet");
    r.setFlags((f) => on.has(f));
    expect(r.list().map((t) => t.id)).toEqual(["feature.chamfer", "feature.fillet"]);
    expect(r.keymap("model").get("shift+f")).toBe("feature.fillet");
    expect(() => r.register(tool({ id: "feature.fillet" }))).toThrow(/already registered/);
  });
});

async function shellHarness(source = BOX) {
  const h = await makeHarness({ source, agent: true });
  const shellCommands = createShellCommandRegistry(() => h.services);
  const shell = new Shell({ services: h.services, commands: h.commands, shellCommands });
  attachShell(h.services, shell);
  return { ...h, shell, shellCommands };
}

const spec = (over: Partial<PanelSpec> = {}): PanelSpec => ({
  title: "Offset",
  fields: [{ kind: "number", key: "d", label: "Distance", quantity: "length", default: "2", min: 0 }],
  previewDelayMs: 0,
  ...over,
});

describe("the shell", () => {
  it("starts a tool, opens its panel in the right dock and closes it on OK", async () => {
    const { shell, services } = await shellHarness();
    const commit = vi.fn().mockResolvedValue({ ok: true });
    shell.tools.register(tool({ id: "feature.offset", label: "Offset", activate: () => spec({ commit }) }));
    services.ui.setPanel("right", false);
    const r = await shell.startTool("feature.offset");
    expect(r).toEqual({ started: true, panel: true });
    expect(shell.getState()).toMatchObject({ activeToolId: "feature.offset", rightTab: "properties", lastToolId: "feature.offset" });
    expect(services.ui.getState().panels.right).toBe(true);
    const ok = await shell.commitPanel();
    expect(ok.ok).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(shell.getState()).toMatchObject({ panel: null, activeToolId: null, rightTab: "code" });
  });

  it("refuses disabled tools with their reason, and tools of another mode", async () => {
    const { shell } = await shellHarness();
    shell.tools.register(tool({ id: "feature.offset", enabledWhen: () => ({ reason: "Select a face first" }) }));
    shell.tools.register(tool({ id: "sketch.line", label: "Line", group: "sketch", modes: ["sketch"] }));
    expect(await shell.startTool("feature.offset")).toMatchObject({ started: false, reason: "Select a face first" });
    expect(await shell.startTool("sketch.line")).toMatchObject({ started: false, reason: expect.stringContaining("sketch mode") });
    shell.setMode("sketch");
    expect((await shell.startTool("sketch.line")).started).toBe(true);
    expect(await shell.startTool("nope.nope")).toMatchObject({ started: false, reason: "unknown tool: nope.nope" });
    shell.tools.register(tool({ id: "feature.draft", label: "Draft", flag: "draft" }));
    shell.tools.setFlags(() => false);
    expect(await shell.startTool("feature.draft")).toMatchObject({ started: false, reason: "feature.draft is not in this build yet (its flag is off)" });
  });

  it("reports a tool that throws on start and leaves nothing open", async () => {
    const { shell, services } = await shellHarness();
    shell.tools.register(tool({ id: "feature.broken", activate: () => Promise.reject(new Error("no sketch plane")) }));
    const r = await shell.startTool("feature.broken");
    expect(r).toMatchObject({ started: false, reason: "no sketch plane" });
    expect(shell.getState().panel).toBeNull();
    expect(services.ui.getState().toasts.at(-1)?.message).toBe("Fillet: no sketch plane");
  });

  it("a new tool replaces (and cancels) the open one; a mode switch and a new document close it", async () => {
    const { shell, commands } = await shellHarness();
    const cancel = vi.fn();
    shell.tools.register(tool({ id: "feature.a", activate: (ctx) => void ctx.openPanel(spec({ cancel })) }));
    shell.tools.register(tool({ id: "feature.b", activate: () => spec() }));
    await shell.startTool("feature.a");
    await shell.startTool("feature.b");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(shell.getState().activeToolId).toBe("feature.b");
    shell.setMode("sketch");
    expect(shell.getState().panel).toBeNull();
    shell.setMode("model");
    await shell.startTool("feature.b");
    await commands.execute({ id: "file.new" });
    expect(shell.getState().panel).toBeNull();
  });

  it("shows the open panel's preview bodies until it closes or another document loads", async () => {
    const { shell, engine, commands } = await shellHarness();
    const { bodies } = await engine.evaluate(JSON.stringify({ schema: "aicad.ir/0", parts: [{ id: "p", name: "p", features: [{ type: "extrude", id: "e", name: "e", sketch: "s" }] }] }));
    shell.tools.register(tool({ id: "feature.offset", activate: () => spec({ preview: () => ({ ok: true, bodies }) }) }));
    await shell.startTool("feature.offset");
    await shell.getState().panel!.settled();
    expect(shell.getState()).toMatchObject({ previewBodies: bodies, previewStale: false });
    shell.getState().panel!.set("d", "3");
    expect(shell.getState()).toMatchObject({ previewBodies: bodies, previewStale: true });
    shell.cancelPanel();
    expect(shell.getState()).toMatchObject({ previewBodies: null, previewStale: false });
    await shell.startTool("feature.offset");
    await shell.getState().panel!.settled();
    await commands.execute({ id: "file.new" });
    expect(shell.getState().previewBodies).toBeNull();
  });

  it("drops the late preview of a panel that was cancelled or replaced", async () => {
    const { shell, engine } = await shellHarness();
    const { bodies } = await engine.evaluate(JSON.stringify({ schema: "aicad.ir/0", parts: [{ id: "p", name: "p", features: [{ type: "extrude", id: "e", name: "e", sketch: "s" }] }] }));
    let answer!: (o: PreviewOutcome) => void;
    shell.tools.register(tool({ id: "feature.slow", activate: () => spec({ preview: () => new Promise<PreviewOutcome>((r) => (answer = r)) }) }));
    shell.tools.register(tool({ id: "feature.other", label: "Other", activate: () => spec() }));
    await shell.startTool("feature.slow");
    await new Promise((r) => setTimeout(r, 5));
    shell.cancelPanel();
    answer({ ok: true, bodies });
    await new Promise((r) => setTimeout(r, 5));
    expect(shell.getState().previewBodies).toBeNull();
    await shell.startTool("feature.slow");
    await new Promise((r) => setTimeout(r, 5));
    await shell.startTool("feature.other");
    answer({ ok: true, bodies });
    await new Promise((r) => setTimeout(r, 5));
    expect(shell.getState().previewBodies).toBeNull();
  });

  it("tool.start args prefill the panel; an unknown input is refused and nothing opens", async () => {
    const { shell, shellCommands } = await shellHarness();
    shell.tools.register(tool({ id: "feature.offset", label: "Offset", activate: () => spec() }));
    expect(await shellCommands.execute({ id: "tool.start", args: { id: "feature.offset", args: { d: 7.5 } } })).toEqual({ ok: true, value: { started: true, panel: true } });
    expect(shell.getState().panel!.values()["d"]).toMatchObject({ text: "7.5", value: 7.5 });
    const bad = await shellCommands.execute({ id: "tool.start", args: { id: "feature.offset", args: { depth: 1 } } });
    expect(bad).toMatchObject({ ok: false, error: { message: expect.stringContaining("has no input depth") } });
    expect(shell.getState().panel).toBeNull();
  });

  it("has the plan's toolbar groups, print included", () => {
    expect(TOOL_GROUPS.map((g) => g.id)).toEqual(["sketch", "create", "modify", "pattern", "inspect", "construct", "print"]);
  });

  it("drives tools through the shell commands (tool.start / tool.commit / tool.cancel / tool.list)", async () => {
    const { shell, shellCommands } = await shellHarness();
    const commit = vi.fn().mockResolvedValue({ ok: true, message: "done" });
    shell.tools.register(tool({ id: "feature.offset", label: "Offset", activate: () => spec({ commit }) }));
    expect(await shellCommands.execute({ id: "tool.commit" })).toMatchObject({ ok: false, error: { code: "DISABLED" } });
    expect(await shellCommands.execute({ id: "tool.start", args: { id: "feature.offset" } })).toEqual({ ok: true, value: { started: true, panel: true } });
    expect(await shellCommands.execute({ id: "tool.commit" })).toEqual({ ok: true, value: { committed: true, message: "done" } });
    await shellCommands.execute({ id: "tool.start", args: { id: "feature.offset" } });
    expect(await shellCommands.execute({ id: "tool.cancel" })).toEqual({ ok: true, value: { cancelled: true } });
    const list = await shellCommands.execute({ id: "tool.list" });
    expect(list).toMatchObject({ ok: true, value: { tools: [{ id: "feature.offset", enabled: true, shortcut: null }] } });
    expect(await shellCommands.execute({ id: "tool.start", args: { id: "x.y" } })).toMatchObject({ ok: false, error: { message: "unknown tool: x.y" } });
    expect(await shellCommands.execute({ id: "tool.repeat" })).toMatchObject({ ok: true });
    expect(shell.getState().activeToolId).toBe("feature.offset");
  });

  it("routes commands to the registry that has them and merges keymaps (app keys first)", async () => {
    const { shell } = await shellHarness();
    expect(shell.registryFor("file.new")).toBe(shell.commands);
    expect(shell.registryFor("help.shortcuts")).toBe(shell.registries[1]);
    const keys = shell.commandKeymap();
    expect(keys.get("mod+k")).toBe("view.commandPalette");
    expect(keys.get("shift+?")).toBe("help.shortcuts");
    expect(keys.get("space")).toBe("tool.repeat");
    expect((await shell.execute({ id: "help.shortcuts" })).ok).toBe(true);
    expect(shell.getState().dialog).toBe("shortcuts");
    expect(shell.paletteItems().some((p) => p.id === "help.welcome")).toBe(true);
  });

  it("gives tools the document selection as selection items", async () => {
    const { shell, commands } = await shellHarness();
    await commands.execute({ id: "selection.selectEntity", args: { body: "plate/plate", face: "plate/cap:end", reveal: false } });
    expect(shell.selection.items()).toEqual([{ kind: "face", part: "plate", key: "plate/cap:end", body: "plate/plate" }]);
    await commands.execute({ id: "selection.clear" });
    await commands.execute({ id: "selection.selectFeature", args: { feature: "outline", reveal: false } });
    expect(shell.selection.items()).toMatchObject([{ kind: "feature", label: "outline" }]);
  });

  it("uses a bound selection port instead of the document's", async () => {
    const { shell } = await shellHarness();
    const port = staticSelectionPort([{ kind: "edge", part: "p", key: "e" }]);
    shell.bindPorts({ selection: port });
    expect(shell.selection.items()).toEqual([{ kind: "edge", part: "p", key: "e" }]);
  });

  it("shows the welcome screen over a blank document only", async () => {
    const { shell, services, commands } = await shellHarness(BLANK_SOURCE);
    expect(isBlankDocument(services)).toBe(true);
    expect(shell.welcomeVisible()).toBe(true);
    shell.dismissWelcome();
    expect(shell.welcomeVisible()).toBe(false);
    await commands.execute({ id: "file.new" });
    await services.doc.idle();
    expect(shell.welcomeVisible()).toBe(true);
    await commands.execute({ id: "doc.setSource", args: { source: BOX } });
    await services.doc.idle();
    expect(shell.welcomeVisible()).toBe(false);
    shell.showWelcome();
    expect(shell.welcomeVisible()).toBe(true);
    expect(shellOf(services)).toBe(shell);
  });

  it("hides the welcome screen while the agent works", async () => {
    const { shell, commands, services } = await shellHarness(BLANK_SOURCE);
    services.agent.setCodeTab("code");
    const r = await commands.execute({ id: "chat.send", args: { text: "a 20 mm cube" } });
    expect(r.ok).toBe(true);
    expect(services.agent.getState().activeRunId).not.toBeNull();
    expect(shell.welcomeVisible()).toBe(false);
  });
});

/** A tool that sets the plate's thickness with a `setField` op, and re-edits extrudes (`fromFeature`). */
function thicknessTool(): ToolDefinition {
  const panel = (feature: string, distance: number): PanelSpec => ({
    title: "Thickness",
    fields: [{ kind: "number", key: "d", label: "Thickness", quantity: "length", min: 0, minExclusive: true, default: String(distance) }],
    previewDelayMs: 0,
    toOps: (v) => [{ op: "setField", feature, path: "/distance", value: (v["d"] as NumberValue).value }],
    label: (v) => `Thickness ${(v["d"] as NumberValue).text} mm`,
  });
  return tool({
    id: "feature.thickness",
    label: "Thickness",
    features: ["extrude"],
    activate: (ctx) => {
      const f = ctx.document.feature("plate");
      if (!f) throw new Error("no plate");
      return panel(f.id, f.json["distance"] as number);
    },
    fromFeature: (f) => panel(f.id, f.json["distance"] as number),
  });
}

describe("tools change the document with ops, against the document as it is at OK time", () => {
  it("OK applies the ops as one undo step", async () => {
    const { shell, services } = await shellHarness();
    shell.tools.register(thicknessTool());
    await shell.startTool("feature.thickness");
    shell.getState().panel!.set("d", "8");
    expect((await shell.commitPanel()).ok).toBe(true);
    await services.doc.idle();
    expect(services.doc.getState().source).toContain("distance: 8");
    expect(services.doc.getState().history.undoLabel).toBe("Thickness 8 mm");
    services.doc.undo();
    expect(services.doc.getState().source).toContain("distance: 5");
  });

  it("an edit made while the panel is open (the agent, the code editor) is kept, not overwritten by OK", async () => {
    const { shell, services, commands } = await shellHarness();
    shell.tools.register(thicknessTool());
    await shell.startTool("feature.thickness");
    const panel = shell.getState().panel!;
    panel.set("d", "8");
    await panel.settled();
    // Someone else widens the outline while the panel is open.
    const widened = services.doc.getState().source.replace(/25/g, "30");
    expect((await commands.execute({ id: "doc.setSource", args: { source: widened, label: "Agent edit" } })).ok).toBe(true);
    await services.doc.idle();
    expect((await shell.commitPanel()).ok).toBe(true);
    await services.doc.idle();
    const src = services.doc.getState().source;
    expect(src).toContain("distance: 8");
    expect(src).toContain("[30, 30]");
    expect(src).not.toContain("25");
    // One undo step for the tool: the other edit stays.
    services.doc.undo();
    expect(services.doc.getState().source).toBe(widened);
  });

  it("feature.edit opens the tool that makes the feature, prefilled from it, and OK changes that feature", async () => {
    const { shell, shellCommands, services } = await shellHarness();
    shell.tools.register(thicknessTool());
    expect(await shellCommands.execute({ id: "feature.edit", args: { feature: "plate" } })).toEqual({ ok: true, value: { started: true, panel: true, tool: "feature.thickness" } });
    const panel = shell.getState().panel!;
    expect(panel.values()["d"]).toMatchObject({ value: 5 });
    panel.set("d", "6");
    expect((await shellCommands.execute({ id: "tool.commit" })).ok).toBe(true);
    await services.doc.idle();
    expect(services.doc.getState().source).toContain("distance: 6");
    expect(await shellCommands.execute({ id: "feature.edit", args: { feature: "outline" } })).toMatchObject({ ok: false, error: { message: "no tool edits sketch features yet" } });
    expect(await shellCommands.execute({ id: "feature.edit", args: { feature: "nope" } })).toMatchObject({ ok: false, error: { message: "there is no feature nope" } });
  });

  it("an open panel re-checks when the document changes (undo, the agent)", async () => {
    const { shell, services, commands } = await shellHarness();
    const seen: number[] = [];
    shell.tools.register(
      tool({
        id: "inspect.distance",
        activate: (ctx) => ({
          title: "Distance",
          readOnly: true,
          fields: [],
          previewDelayMs: 0,
          preview: async () => {
            await ctx.services.doc.idle();
            const d = ctx.document.feature("plate")!.json["distance"] as number;
            seen.push(d);
            return { ok: true, summary: [{ label: "Distance", value: String(d) }] };
          },
        }),
      }),
    );
    await shell.startTool("inspect.distance");
    const panel = shell.getState().panel!;
    await panel.settled();
    expect(panel.getState().summary).toEqual([{ label: "Distance", value: "5" }]);
    await commands.execute({ id: "doc.setSource", args: { source: services.doc.getState().source.replace("distance: 5", "distance: 9") } });
    await services.doc.idle();
    await panel.settled();
    expect(panel.getState().summary).toEqual([{ label: "Distance", value: "9" }]);
    await commands.execute({ id: "edit.undo" });
    await services.doc.idle();
    await panel.settled();
    expect(panel.getState().summary).toEqual([{ label: "Distance", value: "5" }]);
    expect(seen.at(-1)).toBe(5);
  });
});

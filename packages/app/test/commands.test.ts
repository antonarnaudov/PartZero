import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compile } from "@aicad/cadscript";
import { COMMANDS } from "../src/commands/commands";
import { CommandRegistry, defineCommand, eventToKey, formatKey, normalizeKey } from "../src/commands/registry";
import { TEMPLATES } from "../src/host/templates";
import { BOX, makeHarness } from "./helpers";

describe("CommandRegistry", () => {
  interface Ctx {
    log: string[];
    enabled: boolean;
  }
  const cmd = defineCommand<Ctx>();
  const specs = {
    "test.greet": cmd({
      id: "test.greet",
      title: "Greet",
      category: "Help",
      args: z.strictObject({ name: z.string().min(1), times: z.number().int().min(1).default(1) }),
      keys: ["Mod+G"],
      run: ({ name, times }, ctx) => {
        ctx.log.push(name);
        return { text: `hello ${name}`.repeat(times) };
      },
    }),
    "test.fail": cmd({
      id: "test.fail",
      title: "Fail",
      category: "Help",
      args: z.strictObject({}),
      run: () => {
        throw new Error("boom");
      },
    }),
    "test.gated": cmd({
      id: "test.gated",
      title: "Gated",
      category: "Help",
      args: z.strictObject({}),
      enabled: (ctx) => ctx.enabled,
      run: () => "ran",
    }),
    "test.variants": cmd({
      id: "test.variants",
      title: "Variants",
      category: "View",
      args: z.strictObject({ v: z.enum(["a", "b"]) }),
      palette: [
        { title: "Variant A", args: { v: "a" } },
        { title: "Variant B", args: { v: "b" } },
      ],
      run: ({ v }) => v,
    }),
  };
  const ctx: Ctx = { log: [], enabled: false };
  const registry = new CommandRegistry(specs, () => ctx);

  it("validates arguments with zod and applies defaults", async () => {
    const r = await registry.execute({ id: "test.greet", args: { name: "ada" } });
    expect(r).toEqual({ ok: true, value: { text: "hello ada" } });
    expect(ctx.log).toEqual(["ada"]);
  });

  it("rejects invalid arguments with per-field issues and never runs the command", async () => {
    const r = await registry.executeUnknown({ id: "test.greet", args: { name: "", extra: 1 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ARGS");
    expect(r.error.issues?.map((i) => i.path)).toEqual(expect.arrayContaining(["name"]));
    expect(ctx.log).toEqual(["ada"]);
  });

  it("reports unknown commands, malformed invocations, disabled commands and failures as results", async () => {
    expect(await registry.executeUnknown({ id: "nope" })).toMatchObject({ ok: false, error: { code: "UNKNOWN_COMMAND" } });
    expect(await registry.executeUnknown("file.open")).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(await registry.execute({ id: "test.gated" })).toMatchObject({ ok: false, error: { code: "DISABLED" } });
    ctx.enabled = true;
    expect(await registry.execute({ id: "test.gated" })).toEqual({ ok: true, value: "ran" });
    expect(await registry.execute({ id: "test.fail" })).toMatchObject({ ok: false, error: { code: "FAILED", message: "boom" } });
  });

  it("notifies listeners of every execution with its source", async () => {
    const seen: string[] = [];
    const off = registry.onDidExecute((r) => seen.push(`${r.id}:${r.source}:${r.ok}`));
    await registry.execute({ id: "test.greet", args: { name: "x" } }, { source: "agent" });
    await registry.executeUnknown({ id: "missing" }, { source: "mcp" });
    off();
    expect(seen).toEqual(["test.greet:agent:true", "missing:mcp:false"]);
  });

  it("describes commands with JSON Schemas (agent/MCP tool definitions)", () => {
    const info = registry.describe().find((c) => c.id === "test.greet")!;
    expect(info.keys).toEqual(["Mod+G"]);
    expect(info.argsSchema).toMatchObject({
      type: "object",
      properties: { name: { type: "string", minLength: 1 }, times: { type: "integer" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("lists palette items: arg-less commands and fixed-argument variants", () => {
    const items = registry.paletteItems().map((i) => [i.id, i.title, i.args]);
    expect(items).toContainEqual(["test.fail", "Fail", {}]);
    expect(items).toContainEqual(["test.variants", "Variant B", { v: "b" }]);
    expect(items.some(([id]) => id === "test.greet")).toBe(false);
  });

  it("refuses spec maps whose keys and ids disagree", () => {
    expect(() => new CommandRegistry({ wrong: specs["test.fail"] }, () => ctx)).toThrow(/does not match/);
  });
});

describe("keybindings", () => {
  it("normalizes, matches events and formats per platform", () => {
    expect(normalizeKey("Shift+Mod+z")).toBe("mod+shift+z");
    const ev = { key: "Z", code: "KeyZ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
    expect(eventToKey(ev, true)).toBe("mod+shift+z");
    expect(eventToKey({ ...ev, metaKey: false, ctrlKey: true }, false)).toBe("mod+shift+z");
    expect(eventToKey({ key: "Escape", code: "Escape", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, true)).toBe("escape");
    expect(formatKey("Mod+Shift+Z", true)).toBe("⌘⇧Z");
    expect(formatKey("Mod+Shift+Z", false)).toBe("Ctrl+Shift+Z");
  });

  it("app keybindings are unique", () => {
    const seen = new Map<string, string>();
    for (const spec of Object.values(COMMANDS)) {
      for (const k of spec.keys ?? []) {
        const key = normalizeKey(k);
        expect(seen.get(key), `${k} bound twice`).toBeUndefined();
        seen.set(key, spec.id);
      }
    }
  });
});

describe("app commands", () => {
  it("every command describes itself with an object JSON Schema", async () => {
    const { commands } = await makeHarness();
    const infos = commands.describe();
    expect(infos.length).toBe(Object.keys(COMMANDS).length);
    for (const info of infos) {
      expect(info.id).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
      expect(info.argsSchema).toMatchObject({ type: "object" });
    }
  });

  it("creates a document from a MakerBench template", async () => {
    const { commands, services } = await makeHarness();
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(20);
    const r = await commands.execute({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } });
    expect(r).toMatchObject({ ok: true, value: { created: true } });
    const s = await services.doc.idle();
    expect(s.name).toBe("t1-nema17-plate");
    expect(s.model?.ir?.parts[0]?.features.map((f) => f.name)).toEqual(["outline", "plate"]);
    expect(s.report?.status).toBe("ok");
    expect(await commands.execute({ id: "file.newFromTemplate", args: { templateId: "nope" } })).toMatchObject({ ok: false, error: { code: "FAILED" } });
  });

  it("without a template id, opens the picker instead", async () => {
    const { commands, services } = await makeHarness();
    await commands.execute({ id: "file.newFromTemplate" });
    expect(services.ui.getState().dialog).toBe("templates");
  });

  it("every template compiles cleanly", () => {
    for (const t of TEMPLATES) {
      const r = compile(t.source);
      expect(r.diagnostics.filter((d) => d.severity === "error"), t.id).toEqual([]);
    }
  });

  it("setSource / undo / redo go through the command layer", async () => {
    const { commands, services } = await makeHarness({ source: BOX });
    const edited = BOX.replace("distance: 5", "distance: 12");
    expect(await commands.execute({ id: "doc.setSource", args: { source: edited, label: "Thicker" } })).toMatchObject({ ok: true, value: { changed: true } });
    expect(services.doc.getState().history.undoLabel).toBe("Thicker");
    expect(await commands.execute({ id: "edit.undo" })).toMatchObject({ ok: true, value: { undone: true, label: "Thicker" } });
    expect(services.doc.getState().source).toBe(BOX);
    expect(await commands.execute({ id: "edit.redo" })).toMatchObject({ ok: true, value: { redone: true } });
    expect(services.doc.getState().source).toBe(edited);
  });

  it("selects features by id or name and reveals them in the code", async () => {
    const { commands, services, reveals } = await makeHarness({ source: BOX });
    const r = await commands.execute({ id: "selection.selectFeature", args: { feature: "plate" } });
    expect(r.ok).toBe(true);
    const id = services.doc.getState().model!.ir!.parts[0]!.features[1]!.id;
    expect(services.doc.getState().selection).toMatchObject({ featureId: id, origin: "command" });
    expect(reveals.at(-1)?.line).toBe(BOX.split("\n").findIndex((l) => l.startsWith("const plate")) + 1);
  });

  it("maps a picked face to its feature (provenance)", async () => {
    const { commands, services } = await makeHarness({ source: BOX });
    const r = await commands.execute({ id: "selection.selectEntity", args: { body: "plate/plate", face: "plate/side:bottom" } });
    expect(r).toMatchObject({ ok: true, value: { feature: "plate" } });
    expect(services.doc.getState().selection.entity).toEqual({ body: "plate/plate", face: "plate/side:bottom" });
    const r2 = await commands.execute({ id: "selection.selectEntity", args: { body: "plate/plate", edge: "outline/edge:{outline/x|plate/cap:end}" } });
    expect(r2).toMatchObject({ ok: true, value: { feature: "outline" } });
  });

  it("suppresses and unsuppresses a feature by splicing the source", async () => {
    const { commands, services, engine } = await makeHarness({ source: BOX });
    const r = await commands.execute({ id: "feature.setSuppressed", args: { feature: "plate", suppressed: true } });
    expect(r).toMatchObject({ ok: true, value: { changed: true } });
    let s = await services.doc.idle();
    expect(s.source).toContain("const plate = extrude(outline, { distance: 5, suppressed: true });");
    expect(s.source).toContain("// The outline."); // untouched text survives the splice
    expect(s.bodies).toHaveLength(0);
    expect(s.history.undoLabel).toBe("Suppress plate");
    await commands.execute({ id: "feature.setSuppressed", args: { feature: "plate", suppressed: false } });
    s = await services.doc.idle();
    expect(s.source).toBe(BOX);
    expect(engine.evaluations.length).toBeGreaterThanOrEqual(3);
  });

  it("applies an IR edit (zod-validated IR) as one transaction", async () => {
    const { commands, services } = await makeHarness({ source: BOX });
    const ir = structuredClone(services.doc.getState().compile!.ir!);
    const plate = ir.parts[0]!.features[1]!;
    if (plate.type !== "extrude") throw new Error("expected extrude");
    plate.distance = 7.5;
    expect(await commands.execute({ id: "doc.applyIr", args: { ir, label: "Set thickness" } })).toMatchObject({ ok: true });
    const s = await services.doc.idle();
    expect(s.source).toContain("distance: 7.5");
    expect(await commands.executeUnknown({ id: "doc.applyIr", args: { ir: { schema: 1 } } })).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
  });

  it("exports a mesh through the engine and writes it via the host", async () => {
    const { commands, host, engine } = await makeHarness({ source: BOX });
    host.nextSavePath = "/out/box.3mf";
    const r = await commands.execute({ id: "file.exportMesh", args: { format: "3mf" } });
    expect(r).toMatchObject({ ok: true, value: { exported: true, path: "/out/box.3mf", format: "3mf" } });
    expect(host.saveDialogs.at(-1)?.defaultPath).toBe("test.3mf");
    expect(new TextDecoder().decode(host.files.get("/out/box.3mf") as Uint8Array)).toBe("PK-fake-3mf");
    expect(JSON.parse(engine.exports[0]!.irJson).schema).toBe("aicad.ir/0");
    // Cancelled dialog: nothing exported.
    host.nextSavePath = null;
    expect(await commands.execute({ id: "file.exportMesh", args: { format: "stl" } })).toMatchObject({ ok: true, value: { exported: false } });
  });

  it("refuses to export while the code has errors", async () => {
    const { commands } = await makeHarness({ source: `${BOX}\nconst x = extrude(nope, { distance: 1 });\n` });
    const r = await commands.execute({ id: "file.exportMesh", args: { format: "stl", path: "/out/x.stl" } });
    expect(r).toMatchObject({ ok: false, error: { code: "FAILED" } });
    // CS_UNRESOLVED_SKETCH from the compiler + TS2304 from the type-checker.
    if (!r.ok) expect(r.error.message).toMatch(/the code has 2 errors/);
  });

  it("saves CadScript and IR JSON, and opens IR JSON as CadScript", async () => {
    const { commands, services, host } = await makeHarness({ source: BOX });
    host.nextSavePath = "/work/box.cad.ts";
    services.doc.setSource(`${BOX}// more\n`);
    expect(await commands.execute({ id: "file.save" })).toMatchObject({ ok: true, value: { saved: true, format: "cadscript" } });
    expect(host.files.get("/work/box.cad.ts")).toBe(`${BOX}// more\n`);
    expect(services.doc.getState()).toMatchObject({ dirty: false, path: "/work/box.cad.ts", name: "box" });

    expect(await commands.execute({ id: "file.saveAs", args: { path: "/work/box.json" } })).toMatchObject({ ok: true, value: { format: "ir-json" } });
    const saved = JSON.parse(host.files.get("/work/box.json") as string);
    expect(saved.schema).toBe("aicad.ir/0");

    host.nextOpenPath = "/work/box.json";
    expect(await commands.execute({ id: "file.open" })).toMatchObject({ ok: true, value: { opened: true, format: "ir-json" } });
    const s = await services.doc.idle();
    expect(s.format).toBe("ir-json");
    expect(s.source).toContain("const plate = extrude(outline, { distance: 5 });");
    expect(s.model?.ir?.parts[0]?.features.map((f) => f.id)).toEqual(saved.parts[0].features.map((f: { id: string }) => f.id));
    expect(services.ui.getState().recentFiles).toContain("/work/box.json");
  });

  it("asks before discarding unsaved changes", async () => {
    const { commands, services, confirmAnswer } = await makeHarness({ source: BOX });
    services.doc.setSource(`${BOX}\n// dirty\n`);
    confirmAnswer.value = false;
    expect(await commands.execute({ id: "file.new" })).toMatchObject({ ok: true, value: { created: false } });
    expect(services.doc.getState().source).toContain("// dirty");
    confirmAnswer.value = true;
    expect(await commands.execute({ id: "file.new" })).toMatchObject({ ok: true, value: { created: true } });
    await services.doc.idle();
  });

  it("chat.send without an agent host (web) records the message with selection chips and says the agent is unavailable", async () => {
    const { commands, services } = await makeHarness({ source: BOX });
    await commands.execute({ id: "selection.selectEntity", args: { body: "plate/plate", face: "plate/cap:end" } });
    const r = await commands.execute({ id: "chat.send", args: { text: "make this 2 mm thicker" } });
    expect(r).toEqual({ ok: true, value: { delivered: false, reason: "AGENT_UNAVAILABLE" } });
    const chat = services.ui.getState().chat;
    const user = chat.find((m) => m.role === "user")!;
    expect(user.chips.map((c) => `${c.kind}:${c.label}`)).toEqual(["feature:plate", "face:plate/cap:end"]);
    expect(chat.at(-1)?.text).toMatch(/runs in the desktop app/);
    expect(await commands.executeUnknown({ id: "chat.send", args: { text: "   " } })).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
  });

  it("view and panel commands update UI state", async () => {
    const { commands, services } = await makeHarness();
    await commands.execute({ id: "view.setTheme", args: { theme: "light" } });
    expect(services.ui.getState().resolvedTheme).toBe("light");
    await commands.execute({ id: "view.toggleTheme" });
    expect(services.ui.getState().resolvedTheme).toBe("dark");
    await commands.execute({ id: "view.togglePanel", args: { panel: "problems", visible: false } });
    expect(services.ui.getState().panels.problems).toBe(false);
    await commands.execute({ id: "view.commandPalette" });
    expect(services.ui.getState().dialog).toBe("palette");
    await commands.execute({ id: "view.setView", args: { view: "top" } });
    expect(services.ui.getState().viewport.view).toBe("top");
  });
});
